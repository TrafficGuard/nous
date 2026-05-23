import { ChatPostMessageResponse, ConversationsHistoryResponse, ConversationsListResponse, ConversationsRepliesResponse, WebClient } from '@slack/web-api';
import { MessageElement } from '@slack/web-api/dist/types/response/ConversationsHistoryResponse';
import { Member } from '@slack/web-api/dist/types/response/UsersListResponse';
import { llms } from '#agent/agentContextUtils';
import { logger } from '#o11y/logger';
import { SlackConfig, slackConfig } from './slackConfig';
import { formatAsSlackBlocks } from './slackConvertToBlocks';
import { textToBlocks } from './slackConvertToMarkdownBlock';

/**
 * A class to interact with the Slack API, specifically for fetching conversations and messages.
 */
export class SlackAPI {
	private client: WebClient;
	private config: SlackConfig = slackConfig();

	constructor() {
		this.client = new WebClient(this.config.botToken);
	}

	async getUsers(): Promise<Member[]> {
		const limit = 999;
		const result = await this.client.users.list({ limit });
		if (result.members?.length === limit) {
			logger.error('Slack API limit reached in listing users. Implement pagination');
		}
		if (!result.ok) throw new Error(`Failed to list users: ${result.error}`);
		if (result.members === undefined) throw new Error('members was undefined in users.list response');
		return result.members;
	}

	async postMessage(channelId: string, threadTs: string, message: string, reply_ts?: string) {
		const params: any = {
			channel: channelId,
			thread_ts: threadTs,
			blocks: await formatAsSlackBlocks(message, llms().medium),
			text: message,
		};

		let result: ChatPostMessageResponse;

		try {
			result = await this.client.chat.postMessage(params);
			if (result.ok) return;

			logger.info({ blocks: params.blocks, error: result.error }, 'Slack post message failed. Retrying with hard LLM');
		} catch (e) {
			logger.info({ blocks: params.blocks, error: e }, 'Slack message post error. Retrying with hard LLM');
		}

		params.blocks = await formatAsSlackBlocks(message, llms().hard);

		try {
			result = await this.client.chat.postMessage(params);
			if (result.ok) return;

			logger.info({ blocks: params.blocks, error: result.error }, 'Slack post message failed. Retrying with plain text');
		} catch (e) {
			logger.info({ blocks: params.blocks, error: e }, 'Slack message post error. Retrying with plain text');
		}

		params.blocks = textToBlocks(message);
		result = await this.client.chat.postMessage(params);

		if (!result.ok) throw new Error(`Failed to send message to Slack: ${result.error}`);
	}

	async getConversationReplies(channelId: string, threadTs: string, limit = 100): Promise<MessageElement[]> {
		let cursor: string | undefined;
		const allMessages: MessageElement[] = [];

		do {
			const response = await this.client.conversations.replies({
				channel: channelId,
				ts: threadTs,
				cursor: cursor,
				limit: 100,
			});
			if (!response.messages) return [];

			allMessages.push(...response.messages);
			cursor = response.response_metadata?.next_cursor;
		} while (cursor);
		return allMessages;
	}

	async fetchThreadMessages(channel: string, parentMessageTs: string): Promise<MessageElement[]> {
		logger.info(`Fetching thread messages for ${parentMessageTs}`);
		const result = await this.client.conversations.replies({
			ts: parentMessageTs,
			channel,
			limit: 1000,
		});

		if (result.error) {
			logger.error(result.error, 'Error fetching thread messages');
			if (!result.messages) return [];
		}
		const messages: MessageElement[] = result.messages!;

		if (result.has_more) {
			const nextResult = await this.client.conversations.replies({
				ts: parentMessageTs,
				cursor: result.response_metadata!.next_cursor,
				channel,
			});
			messages.push(...nextResult.messages!);
		}
		return messages;
	}

	/**
	 * Fetch all messages in a user's App (Direct Message) channel.
	 * @param {string} channelId - The channel ID (like 'DXXX' for a Direct Message).
	 * @param {number} [limit=100] - Optional number of messages to fetch per page. Max is 1000.
	 * @returns {Promise<Array>} - A Promise resolving to an array of message objects.
	 */
	async getConversationHistory(channelId: string, limit = 100) {
		if (!channelId) throw new Error('Channel ID is required to fetch message history');

		const history: MessageElement[] = [];
		let cursor: string | undefined;
		try {
			while (true) {
				const response = await this.client.conversations.history({
					channel: channelId,
					limit: Math.min(limit, 1000), // Slack API max is 1000
					cursor: cursor,
				});

				if (!response.messages) return [];

				history.push(...response.messages);
				cursor = response.response_metadata?.next_cursor || undefined;
				if (!cursor || cursor === '') break;
			}
		} catch (error) {
			throw new Error(`Failed to fetch history: ${error.message}`);
		}
		return history;
	}

	/**
	 * Adds a reaction to a Slack message (e.g., 🤖💥 for "bot broken")
	 * @param channel Slack channel ID (e.g., "C1234567890")
	 * @param messageTimestamp Message timestamp (e.g., "1629378123.000200" from event.message.ts)
	 * @param reaction Emoji name e.g., "robot_face::boom" (separate multiple with ::). Default is 🤖
	 */
	async addReaction(channel: string, messageTimestamp: string, reaction = 'robot_face'): Promise<void> {
		try {
			await this.client.reactions.add({
				channel,
				timestamp: messageTimestamp,
				name: reaction,
			});
			logger.info(`Reaction added: ${reaction} to ${channel} @ ${messageTimestamp}`);
		} catch (error) {
			logger.error(error, `Error adding Slack reaction to ${channel} @ ${messageTimestamp}`);
		}
	}

	/**
	 * Removes a reaction from a Slack message (e.g., 🤖💥 for "bot broken")
	 * @param channel Slack channel ID (e.g., "C1234567890")
	 * @param messageTimestamp Message timestamp (e.g., "1629378123.000200" from event.message.ts)
	 * @param reaction Emoji combo name (e.g., "robot_face::boom")
	 */
	async removeReaction(channel: string, messageTimestamp: string, reaction = 'robot_face'): Promise<void> {
		try {
			await this.client.reactions.remove({
				channel,
				timestamp: messageTimestamp,
				name: reaction,
			});
			logger.info(`Reaction removed: ${reaction} from ${channel} @ ${messageTimestamp}`);
		} catch (error: any) {
			const slackError = error?.data?.error ?? error?.message;
			if (slackError === 'no_reaction') {
				logger.debug(`No reaction ${reaction} found on ${channel} @ ${messageTimestamp}`);
				return;
			}
			logger.error(error, `Error removing Slack reaction from ${channel} @ ${messageTimestamp}`);
		}
	}

	/**
	 * Fetches all accessible conversations (public channels, private channels, DMs, MPIMs)
	 * and subsequently retrieves all messages posted within those conversations
	 * during a specific target day.
	 *
	 * @param targetDate The `Date` object representing the UTC day for which to fetch messages.
	 *                   Example: `new Date(Date.UTC(2025, 6, 23))` for July 23, 2025 UTC.
	 * @returns A Promise that resolves to a `Map` where keys are Slack `channelId` strings
	 *          and values are arrays of message objects (`any[]`) found in that channel on the target day.
	 *          Messages for channels with no activity on the target day will not be included in the Map.
	 *          Also logs messages to the console similar to the original snippet.
	 */
	public async getAllConversationsOnDay(targetDate: Date): Promise<Map<string, any[]>> {
		// Get start and end Unix timestamps for the target day in UTC
		const { start, end } = getDayTimestamps(
			targetDate.getUTCFullYear(),
			targetDate.getUTCMonth() + 1, // getUTCMonth() is 0-indexed, but _getDayTimestamps expects 1-indexed
			targetDate.getUTCDate(),
		);

		const allConversationIds: string[] = [];
		let cursor: string | undefined;

		// Phase 1: Get all conversation IDs
		console.log('Phase 1: Fetching all accessible conversations (channels, DMs, MPIMs)...');
		do {
			try {
				const result: ConversationsListResponse = await this.client.conversations.list({
					types: 'public_channel,private_channel,im,mpim',
					limit: 100, // Fetch up to 100 conversations per API call (recommended max is 100)
					cursor, // For pagination
				});
				if (result.channels) {
					result.channels.forEach((channel) => {
						if (channel?.id) allConversationIds.push(channel.id);
					});
				}
				cursor = result.response_metadata?.next_cursor;
			} catch (error) {
				console.error(`Error fetching conversation list: ${error}`);
				// Optionally rethrow or handle more gracefully
				break; // Exit loop on error
			}
		} while (cursor);
		console.log(`Found ${allConversationIds.length} total conversations.`);

		const conversationsMessagesMap: Map<string, any[]> = new Map();

		// Phase 2: For each conversation, fetch messages for the specific day
		console.log('\nPhase 2: Fetching messages for each conversation on the target day...');
		for (const channelId of allConversationIds) {
			const channelMessages: any[] = [];
			let msgCursor: string | undefined;
			do {
				try {
					const res: ConversationsHistoryResponse = await this.client.conversations.history({
						channel: channelId,
						oldest: start.toString(), // Start of the target day
						latest: end.toString(), // End of the target day
						limit: 500, // Fetch up to 200 messages per API call (recommended max is 1000, 200 is safer)
						inclusive: true, // Include messages exactly at `oldest` or `latest` timestamp
						cursor: msgCursor, // For pagination
					});

					if (res.messages) {
						channelMessages.push(...res.messages);
					}
					msgCursor = res.response_metadata?.next_cursor || undefined;
				} catch (error: any) {
					if (error.data?.error) {
						switch (error.data.error) {
							case 'channel_not_found':
								console.warn(`    WARNING: Channel ${channelId} not found or has been archived. Skipping.`);
								break;
							case 'not_in_channel':
								console.warn(`    WARNING: Bot is not a member of channel ${channelId}. Cannot fetch messages for it.`);
								break;
							case 'is_archived':
								console.warn(`    WARNING: Channel ${channelId} is archived. Skipping.`);
								break;
							case 'account_inactive':
								console.warn(`    WARNING: Bot token is from an inactive account. Skipping channel ${channelId}.`);
								break;
							default:
								console.error(`    ERROR fetching history for channel ${channelId}: ${error.data.error}`);
						}
					} else {
						console.error(`    An unexpected error occurred while fetching history for channel ${channelId}: ${error}`);
					}
					break; // Stop trying to fetch messages for this channel on error
				}
			} while (msgCursor); // Continue paginating until no more messages or error

			if (channelMessages.length > 0) {
				console.log(`    Found ${channelMessages.length} messages in channel ${channelId}.`);
				// Log messages to console the same way the original snippet did
				console.log(`Messages from ${channelId}:`, channelMessages);
				conversationsMessagesMap.set(channelId, channelMessages);
			} else {
				console.log(`    No messages found in channel ${channelId} for the target day.`);
			}
		}
		console.log('\nMessage fetching complete.');
		return conversationsMessagesMap;
	}
}

/**
 * Helper: Calculates the start and end Unix timestamps (in seconds) for a given UTC day.
 * This is a static private method as it doesn't depend on the instance's state.
 * @param year UTC year (e.g., 2025)
 * @param month UTC month (1-12, e.g., 7 for July)
 * @param day UTC day of month (1-31)
 * @returns An object containing 'start' and 'end' Unix timestamps.
 */
function getDayTimestamps(year: number, month: number, day: number): { start: number; end: number } {
	// Date.UTC expects month to be 0-indexed (0 for Jan, 11 for Dec), so we adjust month-1.
	// getUTCMonth() returns 0-11, so it needs +1 before passing to this function, then -1 here.
	const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)).getTime() / 1000;
	// To include the entire last second of the day, add 999 milliseconds to 23:59:59.
	const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)).getTime() / 1000;
	return { start, end };
}
