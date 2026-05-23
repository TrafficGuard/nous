import { llms } from '#agent/agentContextUtils';

/**
 *
 * @param requirements
 * @param issueId
 */
export async function createBranchName(requirements: string, issueId?: string): Promise<string> {
	let branchName = await llms().medium.generateTextWithResult(
		`<requirements>${requirements}</requirement>\n
		From the requirements generate a Git branch name (up to about 10 words/200 characters maximum) to make the changes on. Separate words with dashes.
		If an issue tracker id is found in the requirements then prefix the branch name with it. e.g. JIRA-123-task-description.
		Output your response in <result></result>`,
		{ id: 'Create branch name' },
	);
	if (issueId) branchName = `${issueId}-${branchName}`;
	return branchName;
}
