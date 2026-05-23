import { existsSync, fstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { systemDir } from '#app/appDirs';
import { logger } from '#o11y/logger';
import { terminalLog } from './terminal';

// Define a custom error type
export class CliArgumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CliArgumentError';
	}
}
export interface CliOptions {
	/** Name of the executed .ts file without the extension */
	scriptName: string;
	initialPrompt: string;
	resumeAgentId: string | undefined;
	/** Array of function class names to use */
	functionClasses: string[];
	useSharedRepos?: boolean;
	/** LLM selector supplied with -l or --llm */
	llmId?: string;
	/** Map of every CLI flag and its value (boolean true when no value) */
	flags: Record<string, string | boolean>;
}

export function parseProcessArgs(): CliOptions {
	const scriptPath = process.argv[1];
	let scriptName = scriptPath.split(path.sep).at(-1);
	scriptName = scriptName!.substring(0, scriptName!.length - 3);
	// console.log(`Script name: ${scriptName}`);

	// Grab the CLI args that were actually delivered to the Node process
	const scriptArgs = process.argv.slice(2);

	// If the command was executed through `npm run script …` *without* a `--` separator
	// then npm strips out the extra arguments.  We can recover them from the
	// npm_config_argv environment variable which contains the original command line.
	try {
		if (process.env.npm_config_argv) {
			const npmArgv = JSON.parse(process.env.npm_config_argv) as { original?: string[] };
			const original = npmArgv.original ?? [];
			// Find the position of the script name (e.g. "gen") and take everything after it
			const idx = original.lastIndexOf(scriptName);
			if (idx > -1) {
				const recovered = original.slice(idx + 1);
				for (const arg of recovered) {
					if (!scriptArgs.includes(arg)) scriptArgs.push(arg);
				}
			}
		}
	} catch {
		/* ignore JSON parse errors or unexpected structures */
	}

	return parseUserCliArgs(scriptName, scriptArgs); // slice shallow copies as we may want to modify the slice later
}

/**
 * Parse function class names from -f=FunctionClass,... command line argument
 */
function parseFunctionArgument(args: string[]): string[] {
	const toolArg = args.find((arg) => arg.startsWith('-f=') || arg.startsWith('-t='));
	// logger.info(`Function arg: ${toolArg}`);
	if (!toolArg) return [];
	return toolArg
		.substring(3)
		.split(',')
		.map((s) => s.trim());
}

export function parseUserCliArgs(scriptName: string, scriptArgs: string[]): CliOptions {
	// Keep an untouched copy for generic flag parsing
	const originalArgs = [...scriptArgs];

	/** Collect all dash-prefixed args into a { flag: value } map */
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < originalArgs.length; i++) {
		const tok = originalArgs[i];
		if (!tok.startsWith('-')) continue;

		let key = '';
		let val: string | boolean = true;

		// long form  --foo or --foo=bar
		if (tok.startsWith('--')) {
			const body = tok.slice(2);
			if (body.includes('=')) {
				const [k, v] = body.split('=');
				key = k;
				val = v;
			} else {
				key = body;
				if (originalArgs[i + 1] && !originalArgs[i + 1].startsWith('-') && !originalArgs[i + 1].startsWith('--')) {
					val = originalArgs[i + 1];
				}
			}
		}
		// short form  -f  -f=bar  -f bar
		else {
			const body = tok.slice(1);
			if (body.includes('=')) {
				const [k, v] = body.split('=');
				key = k;
				val = v;
			} else {
				key = body;
				if (originalArgs[i + 1] && !originalArgs[i + 1].startsWith('-') && !originalArgs[i + 1].startsWith('--')) {
					val = originalArgs[i + 1];
				}
			}
		}
		flags[key] = val;
	}

	// strip out filesystem arg if it exists
	const fsArgIndex = scriptArgs.findIndex((arg) => arg.startsWith('--fs='));
	if (fsArgIndex > -1) {
		scriptArgs.splice(fsArgIndex, 1);
	}

	// Remove the -i flag from prompt arguments
	const iArgIndex = scriptArgs.findIndex((arg) => arg === '-i');
	if (iArgIndex > -1) {
		scriptArgs.splice(iArgIndex, 1);
	}

	// Detect and read any prompt text piped, redirected, or interactively provided via stdin.
	// This uses fstatSync so it works even when the script is launched through `npm run …`
	let stdinPrompt = '';
	try {
		// terminalLog(process.env.NODE_ENV);
		// Do not read from stdin during tests, as it may be polluted by test runners or git hooks.
		if (process.env.NODE_ENV !== 'test') {
			// If -i flag is present, assume interactive input and read from stdin.
			if (flags.i) {
				console.log('Enter prompt (send EOF to finish; e.g. Ctrl+D on a new line):');
				stdinPrompt = readFileSync(0, 'utf-8').trim();
			} else {
				// terminalLog('Checking stdin');
				const stats = fstatSync(0); // fd 0 = stdin
				// Is data coming from a pipe (FIFO) or a redirected file?
				if (stats.isFIFO() || stats.isFile()) {
					// terminalLog('Stdin is a pipe or redirected file');
					stdinPrompt = readFileSync(0, 'utf-8').trim();
					// terminalLog(`Read ${stdinPrompt.length} chars`);
				}
			}
		} else {
			// terminalLog('No stdin detected');
		}
	} catch {
		/* ignore – fall back to CLI args or file */
	}

	// Check if we're resuming an agent
	let resumeAgentId: string | undefined;
	let resumeLastRun = false;
	let i = 0;
	for (; i < scriptArgs.length; i++) {
		if (scriptArgs[i].startsWith('-r')) {
			resumeLastRun = true;
			if (scriptArgs[i].length > 3) resumeAgentId = scriptArgs[i].substring(3);
		} else {
			break;
		}
	}
	resumeAgentId = resumeLastRun ? getLastRunAgentId(scriptName) : undefined;
	if (resumeLastRun) flags.r = resumeAgentId ?? true; // Record the -r flag in the flags map
	if (resumeLastRun && !resumeAgentId) {
		// Throw error instead of exiting
		throw new CliArgumentError('No agentId to resume');
	}
	if (resumeAgentId) {
		// Log only if we are actually resuming
		logger.info(`Resuming agent ${resumeAgentId}`);
	}

	let useSharedRepos = true;
	const privateRepoArgIndex = scriptArgs.findIndex((arg) => arg === '--private');
	if (privateRepoArgIndex > -1) {
		useSharedRepos = false;
		scriptArgs.splice(privateRepoArgIndex, 1); // Remove the flag after processing
	}

	// --- LLM selector --------------------------------------------
	// The llmId value is now parsed into the 'flags' map.
	// We still need to remove the model arguments from scriptArgs to prevent them from becoming part of the prompt.
	const mIdx = scriptArgs.findIndex((a) => a === '-l' || a.startsWith('-l=') || a.startsWith('--llm='));
	if (mIdx > -1) {
		const token = scriptArgs[mIdx];
		if (token === '-l') {
			// If it's '-l value', remove the value part too
			if (scriptArgs[mIdx + 1] && !scriptArgs[mIdx + 1].startsWith('-')) {
				scriptArgs.splice(mIdx + 1, 1);
			}
		}
		scriptArgs.splice(mIdx, 1); // Remove the flag itself
	}
	const llmId: string | undefined = (flags.l as string) || (flags.llm as string); // Assign llm from the flags map
	// console.error(llmId);

	// Extract function classes before processing prompt
	const functionClasses = parseFunctionArgument(scriptArgs);
	// Remove the function argument from args if present
	const promptArgs = scriptArgs.filter((arg) => !arg.startsWith('-t=') && !arg.startsWith('-f='));
	const argsPrompt = promptArgs.slice(i).join(' ').trim();
	let initialPrompt = '';

	// Precedence:
	//   1) piped/stdin input (if any) + append CLI args (if any)
	//   2) CLI args only
	//   3) fallback file
	if (stdinPrompt) {
		initialPrompt = argsPrompt ? `${stdinPrompt}\n\n${argsPrompt}` : stdinPrompt;
	} else {
		initialPrompt = argsPrompt;
	}

	if (!stdinPrompt && (initialPrompt.startsWith('-f') || initialPrompt.startsWith('-t') || initialPrompt.startsWith('--fs') || initialPrompt.startsWith('-r')))
		throw new Error(
			'If running a `npm run` command, the program arguments need to be separated by "--". e.g. "npm run agent -- -f=code,web,jira". Alternatively use the `ai` script as an alias for `npm run` which doesnt required the -- separator, and can be run from any directory.',
		);

	// logger.debug({ functionClasses }, 'Parsed function classes');
	// logger.info(initialPrompt);

	// If no prompt provided then load from file
	if (!initialPrompt.trim()) {
		if (existsSync(`src/cli/${scriptName}-in`)) initialPrompt = readFileSync(`src/cli/${scriptName}-in`, 'utf-8');
	}

	// logger.info(initialPrompt);

	return {
		scriptName,
		resumeAgentId,
		initialPrompt,
		functionClasses,
		useSharedRepos,
		llmId,
		flags,
	};
}

export function saveAgentId(scriptName: string, agentId: string): void {
	const dirPath = join(systemDir(), 'cli');
	mkdirSync(dirPath, { recursive: true });
	writeFileSync(join(dirPath, `${scriptName}.lastRun`), agentId);
}

export function getLastRunAgentId(scriptName: string): string | undefined {
	const filePath = join(systemDir(), 'cli', `${scriptName}.lastRun`);
	if (existsSync(filePath)) {
		return readFileSync(filePath, 'utf-8').trim();
	}
	logger.warn(`No agent to resume for ${scriptName} script`);
	return undefined;
}
