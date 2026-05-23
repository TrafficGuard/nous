import type { DiscussionSchema, EventSchema, Gitlab, JobSchema, SimpleProjectSchema, SimpleUserSchema } from '@gitbeaker/core';
import {
	type CommitDiffSchema,
	type CreateMergeRequestOptions,
	type ExpandedMergeRequestSchema,
	Gitlab as GitlabApi,
	type MergeRequestDiffSchema,
	type PipelineSchema,
	type ProjectSchema,
} from '@gitbeaker/rest';
import type { BranchSchema } from '@gitbeaker/rest';
import type { DeepPartial } from 'ai';
import { func, funcClass } from '#functionSchema/functionDecorators';
import { AbstractSCM } from '#functions/scm/abstractSCM';
import { countTokens } from '#llm/tokens';
import { logger } from '#o11y/logger';
import { span } from '#o11y/trace';
import type { GitProject } from '#shared/scm/git.model';
import { currentUser, functionConfig } from '#user/userContext';
import { envVar } from '#utils/env-var';
import { execCommand } from '#utils/exec';
import { cacheRetry } from '../../cache/cacheRetry';
import type { MergeRequest, SourceControlManagement } from './sourceControlManagement';

export interface GitLabConfig {
	host: string;
	token: string;
	secretName?: string;
	secretProject?: string;
	/** Comma-separated list of the top level groups */
	topLevelGroups: string[];
	groupExcludes?: Set<string>;
}

// Note that the type returned from getProjects is mapped to GitProject
export type GitLabProject = Pick<
	ProjectSchema,
	| 'id'
	| 'name'
	| 'description'
	| 'path_with_namespace'
	| 'http_url_to_repo'
	| 'default_branch'
	| 'archived'
	// | "shared_with_groups"
	| 'visibility'
	| 'owner'
	| 'ci_config_path'
>;

type PipelinePreview = Pick<PipelineSchema, 'id' | 'sha' | 'ref' | 'status'>;

type PartialJobSchema = DeepPartial<JobSchema>;

type PipelineWithJobs = PipelinePreview & { jobs: PartialJobSchema[] };

@funcClass(__filename)
export class GitLab extends AbstractSCM implements SourceControlManagement {
	_gitlab: Gitlab<false> | undefined;
	_config: GitLabConfig | undefined;

	/**
	 * Checks if the GitLab configuration (token, host, groups) is available.
	 * @returns {boolean} True if configured, false otherwise.
	 */
	isConfigured(): boolean {
		// Attempt to get config without triggering the error logging in the config() method
		const config = functionConfig(GitLab) as GitLabConfig;
		const token = config?.token || process.env.GITLAB_TOKEN;
		const host = config?.host || process.env.GITLAB_HOST;
		const groups = config?.topLevelGroups || process.env.GITLAB_GROUPS;

		return !!(token && host && groups);
	}

	toJSON() {
		return {
			host: this.config().host,
		};
	}

	private config(): GitLabConfig {
		if (!this._config) {
			const config = functionConfig(GitLab);
			if (!config.token && !envVar('GITLAB_TOKEN')) logger.error('No GitLab token configured on the user or environment');
			this._config = {
				host: config.host || envVar('GITLAB_HOST'),
				token: config.token || envVar('GITLAB_TOKEN'),
				topLevelGroups: (config.topLevelGroups || envVar('GITLAB_GROUPS')).split(',').map((group: string) => group.trim()),
			};
		}
		return this._config;
	}

	api() {
		this._gitlab ??= new GitlabApi({
			host: `https://${this.config().host}`,
			token: this.config().token,
		});
		return this._gitlab;
	}

	// /**
	//  * Searches the descriptions of all the projects in GitLab to find the project which has the files to edit to complete the requirements
	//  * @param requirements the task requirements
	//  * @returns the GitLab project details (name, git URL etc)
	//  */
	// async selectProject(requirements: string): Promise<GitLabProject> {
	// 	const projects = await this.getProjects();
	// 	const prompt = buildPrompt({
	// 		information: `The following is a list of our projects:\n<projects>${JSON.stringify(projects)}</projects>`,
	// 		requirements,
	// 		action:
	// 			'Select the project object which most closely matches the task and return the object. Output your answer in JSON format',
	// 	});
	//
	// 	const project = await llms().medium.generateTextAsJson(prompt);
	// 	return project;
	// }

	/**
	 * @returns the details of all the projects available
	 */
	@cacheRetry({ scope: 'user', ttlSeconds: 60 })
	@func()
	async getProjects(): Promise<GitProject[]> {
		const allRawProjects: SimpleProjectSchema[] = [];
		const topLevelGroups = this.config().topLevelGroups;
		logger.info(`Fetching projects for top-level groups: ${topLevelGroups.join(', ')}`);

		// Step 1 & 2: Fetch top-level projects and descendant groups concurrently for each top-level group
		const topLevelPromises = topLevelGroups.map(async (group) => {
			logger.info(`Initiating fetch for top-level group: ${group}`);
			const [projects, descendantGroups] = await Promise.all([
				this.api().Groups.allProjects(group, {
					orderBy: 'name',
					perPage: 500, // Keep original limit check logic
				}) as Promise<SimpleProjectSchema[]>,
				this.api().Groups.allDescendantGroups(group, {}) as Promise<any[]>, // Use 'any' or a more specific type if available from Gitbeaker
			]);

			if (projects.length === 500) {
				// Log warning instead of throwing to allow partial results, adjust if strictness is needed
				logger.warn(`Potential pagination issue: Fetched 500 projects for top-level group ${group}. Results might be incomplete.`);
				// throw new Error(`Need to page results for GitLab.getProjects for group ${group}. Exceeded 500 size`);
			}
			logger.info(`Fetched ${projects.length} projects for top-level group: ${group}`);
			logger.info(`Fetched ${descendantGroups.length} descendant groups for top-level group: ${group}`);
			return { group, projects, descendantGroups };
		});

		// TODO should do Promise.settled(), continue with the succesfull ones, and log errors for the other groups, which the account may not have permission for
		const topLevelResults = await Promise.all(topLevelPromises);

		// Step 3: Collect top-level projects and all descendant groups
		const allDescendantGroups: any[] = [];
		for (const result of topLevelResults) {
			allRawProjects.push(...result.projects);
			allDescendantGroups.push(...result.descendantGroups);
		}

		// Step 4: Filter descendant groups
		const groupExcludes = this.config().groupExcludes ?? new Set<string>();
		const filteredDescendantGroups = allDescendantGroups.filter(
			(descendantGroup) => !descendantGroup.full_name.includes('Archive') && !groupExcludes.has(descendantGroup.full_path),
		);

		logger.info(`Fetching projects for ${filteredDescendantGroups.length} relevant descendant groups.`);

		// Step 5 & 6: Fetch projects for filtered descendant groups concurrently
		const pageSize = 100; // Keep original limit check logic
		const descendantPromises = filteredDescendantGroups.map(async (descendantGroup) => {
			logger.info(`Initiating fetch for descendant group: ${descendantGroup.full_path}`);
			const projects: SimpleProjectSchema[] = await this.api().Groups.allProjects(descendantGroup.id, {
				orderBy: 'name',
				perPage: pageSize,
			});

			if (projects.length >= pageSize) {
				logger.warn(
					`Potential pagination issue: Fetched ${pageSize} or more projects for descendant group ${descendantGroup.full_path}. Results might be incomplete.`,
				);
				// Consider throwing an error as before if strictness is needed:
				// throw new Error(`Need pagination for projects for group ${descendantGroup.full_path}. Returned more than ${pageSize}`);
			}
			logger.info(`Fetched ${projects.length} projects for descendant group: ${descendantGroup.full_path}`);
			return projects; // Return the array of projects for this group
		});

		const descendantProjectArrays = await Promise.all(descendantPromises);

		// Step 7: Collect all descendant projects
		for (const projectArray of descendantProjectArrays) {
			allRawProjects.push(...projectArray);
		}

		// Step 8 & 9: Convert all collected raw projects to GitProject format
		const resultProjects = allRawProjects.map((project) => this.convertGitLabToGitProject(project));

		// Step 10: Sort the final list by full path for consistent ordering
		resultProjects.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

		logger.info(`Returning ${resultProjects.length} projects in total.`);
		return resultProjects;
	}

	async getProject(projectId: string | number): Promise<GitProject> {
		const project = await this.api().Projects.show(projectId);
		return this.convertGitLabToGitProject(project);
	}

	private convertGitLabToGitProject(project: SimpleProjectSchema): GitProject {
		if (!project.default_branch) logger.warn(`Defaulting ${project.name} default branch to main`);
		return {
			id: project.id,
			name: project.name,
			namespace: project.namespace.full_path,
			fullPath: `${project.namespace.full_path}/${project.path}`,
			description: project.description,
			defaultBranch: project.default_branch,
			// visibility: project.visibility,
			// archived: project.archived || false,
			type: 'gitlab',
			host: this.config().host,
			extra: { ciConfigPath: project.ci_config_path },
		};
	}

	/**
	 * Clones a project from GitLab to the file system.
	 * To use this project the function FileSystem.setWorkingDirectory must be called after with the returned value
	 * @param projectPathWithNamespace the full project path in GitLab
	 * @returns the file system path where the repository is located. You will need to call FileSystem_setWorkingDirectory() with this result to work with the project.
	 */
	@func()
	async cloneProject(projectPathWithNamespace: string, branchOrCommit?: string, targetDirectory?: string): Promise<string> {
		return await this.cloneGitProject(projectPathWithNamespace, this.config().token, this.config().host, branchOrCommit, targetDirectory);
	}

	/**
	 * Creates a Merge request
	 * @param projectId The full project path or numeric id
	 * @param {string} title The title of the merge request
	 * @param {string} description The description of the merge request
	 * @param sourceBranch The branch to merge in
	 * @param {string} targetBranch The branch to merge to
	 * @return the merge request URL
	 */
	@func()
	async createMergeRequest(projectId: string | number, title: string, description: string, sourceBranch: string, targetBranch: string): Promise<MergeRequest> {
		// Push the branch first
		const pushCmd = `git push --set-upstream origin '${sourceBranch}'`;
		const { exitCode: pushExitCode, stdout: pushStdout, stderr: pushStderr } = await execCommand(pushCmd);
		if (pushExitCode > 0) {
			// Combine stdout and stderr for a comprehensive error message
			const errorMessage = `Failed to push branch '${sourceBranch}' to origin.\nstdout: ${pushStdout}\nstderr: ${pushStderr}`;
			throw new Error(errorMessage);
		}

		// Get user details for assigning the MR
		const email = currentUser().email;
		const userResult: SimpleUserSchema[] = await this.api().Users.all({ search: email });
		let user: SimpleUserSchema | undefined;
		if (userResult.length === 1) user = userResult[0];

		const options: CreateMergeRequestOptions = {
			description,
			squash: true,
			removeSourceBranch: true,
			assigneeId: user?.id,
			reviewerIds: user ? [user.id] : [],
		};
		const mr: ExpandedMergeRequestSchema = await this.api().MergeRequests.create(projectId, sourceBranch, targetBranch, title, options);

		return {
			id: mr.id,
			iid: mr.iid,
			url: mr.web_url,
			title: mr.title,
		};
	}

	/**
	 * Gets the latest pipeline details from a merge request
	 * @param gitlabProjectId The full path or numeric id
	 * @param mergeRequestIId The merge request IID. Can be found in the URL to a pipeline
	 */
	@func()
	async getMergeRequestLatestPipeline(gitlabProjectId: string | number, mergeRequestIId: number): Promise<PipelineWithJobs | null> {
		// allPipelines<E extends boolean = false>(projectId: string | number, mergerequestIId: number, options?: Sudo & ShowExpanded<E>): Promise<GitlabAPIResponse<Pick<PipelineSchema, 'id' | 'sha' | 'ref' | 'status'>[], C, E, void>>;
		const pipelines = await this.api().MergeRequests.allPipelines(gitlabProjectId, mergeRequestIId);
		if (pipelines.length === 0) return null;

		// pipelines.sort((a, b) => (Date.parse(a.created_at) < Date.parse(b.created_at) ? 1 : -1));

		const latestPipeline = pipelines.at(0);
		if (!latestPipeline) return null;

		const fullJobs: JobSchema[] = await this.api().Jobs.all(gitlabProjectId, { pipelineId: latestPipeline.id });
		const jobs: PartialJobSchema[] = fullJobs.map((job) => {
			return {
				id: job.id,
				status: job.status,
				stage: job.stage,
				name: job.name,
				allow_failure: job.allow_failure,

				started_at: job.started_at,
				finished_at: job.finished_at,
				duration: job.duration,
				failure_reason: job.failure_reason,
				user: {
					username: job.user.username,
				},
				commit: {
					id: job.commit.id,
					created_at: job.commit.created_at,
					author_email: job.commit.author_email,
					title: job.commit.title,
					message: job.commit.message,
				},
			};
		});
		return {
			...latestPipeline,
			jobs,
		};
	}

	/**
	 * Gets the logs from the jobs which have failed in a pipeline
	 * @param gitlabProjectId GitLab project full path or the numeric id
	 * @param pipelineId The pipelineId. Can be determined from the URL of a pipeline. https://<gitlab-host>/<group>/[<sub-group>/]<project>/-/pipelines/<pipelineId>
	 * @returns A Record with the job name as the key and the logs as the value.
	 */
	@func()
	async getPipelineFailedJobLogs(gitlabProjectId: string | number, pipelineId: number): Promise<string> {
		logger.info({ gitlabProjectId, pipelineId }, 'Getting pipeline');
		const pipeline = await this.api().Pipelines.show(gitlabProjectId, pipelineId);

		if (pipeline.status !== 'failed' && pipeline.status !== 'blocked') throw new Error(`Pipeline status is not failed or blocked. Status: ${pipeline.status}`);

		logger.info({ gitlabProjectId, pipelineId: pipeline.id }, 'Getting jobs');
		const jobs: JobSchema[] = await this.api().Jobs.all(gitlabProjectId, { pipelineId: pipeline.id });
		const failedJobs = jobs.filter((job) => job.status === 'failed' && job.allow_failure === false);

		let jobLogs = '';
		for (const job of failedJobs) {
			logger.info({ gitlabProjectId, pipelineId: pipeline.id, jobId: job.id }, 'Getting job logs');
			let logs = await this.getJobLogs(gitlabProjectId, job.id.toString());

			// If the logs are longer than ~12,000 tokens, truncate them.
			// Take the first 15,000 characters and the last 35,000 characters
			if (logs.length > 50000) {
				logs = `${logs.slice(0, 15000)}\n(truncated)...\n${logs.slice(-35000)}`;
			}
			jobLogs += `<job-logs job-name="${job.name}">\n${logs}\n</job-logs>`;
		}
		logger.info(`Failed job logs (${await countTokens(jobLogs)} tokens)`);
		return jobLogs;
	}

	/**
	 * Gets the logs from the jobs which have failed in the latest pipeline of a merge request
	 * @param gitlabProjectId GitLab project full path or the numeric id
	 * @param mergeRequestIId The merge request IID. Can get this from the URL of the merge request. https://<gitlab-host>/<group>/[<sub-group>/]<project>/-/merge_requests/<mergeRequestIId>
	 * @returns A Record with the job name as the key and the logs as the value.
	 */
	@func()
	async getMergeRequestPipelineFailedJobLogs(gitlabProjectId: string | number, mergeRequestIId: number): Promise<string> {
		logger.info({ gitlabProjectId, mergeRequestIId }, 'Getting pipelines');
		const pipelines = await this.api().MergeRequests.allPipelines(gitlabProjectId, mergeRequestIId);
		if (pipelines.length === 0) throw new Error('No pipelines for the merge request');

		// pipelines.sort((a, b) => (Date.parse(a.created_at) < Date.parse(b.created_at) ? 1 : -1));
		const latestPipeline = pipelines.at(0);
		if (!latestPipeline) throw new Error('No pipelines for the merge request');

		return this.getPipelineFailedJobLogs(gitlabProjectId, latestPipeline.id);
	}

	/**
	 * @returns the diffs for a merge request
	 */
	// @cacheRetry({ scope: 'execution' })
	@span()
	async getMergeRequestDiffs(gitlabProjectId: string | number, mergeRequestIId: number): Promise<string> {
		const diffSchemas: MergeRequestDiffSchema[] = await this.api().MergeRequests.allDiffs(gitlabProjectId, mergeRequestIId, { perPage: 20 });
		return `<mr-diff>\n${this.formatDiffs(diffSchemas)}\n</mr-diff>`;
	}

	formatDiffs(diffSchemas: CommitDiffSchema[] | MergeRequestDiffSchema[]): string {
		let fileDiffs = '';

		for (const diffSchema of diffSchemas) {
			let attributes = '';
			if (diffSchema.old_path && diffSchema.old_path !== diffSchema.new_path) attributes += `old_path="${diffSchema.old_path}" `;
			if (diffSchema.new_path) attributes += `path="${diffSchema.new_path}" `;
			if (diffSchema.diff_type) attributes += `type="${diffSchema.diff_type}" `;
			if (diffSchema.renamed_file) attributes += 'renamed ';
			if (diffSchema.new_file) attributes += 'new_file ';
			if (diffSchema.deleted_file) attributes += 'deleted ';

			fileDiffs += `<diff ${attributes}>\n`;

			let diff = diffSchema.diff;
			const path = diffSchema.new_path ?? diffSchema.old_path ?? '';

			if (
				path.endsWith('package-lock.json') ||
				path.endsWith('yarn.lock') ||
				path.endsWith('pnpm-lock.yaml') ||
				path.endsWith('requirements.txt') ||
				path.endsWith('pyproject.toml') ||
				path.endsWith('poetry.lock')
			) {
				if (diff.length > 4000) diff = `${diff.slice(0, 4000)}\n(truncated)`;
			}

			fileDiffs += `${diff}\n</diff>\n`;
		}
		return fileDiffs;
	}

	/**
	 * Returns the Git diff for the commit in the git repository that the job is running the pipeline on.
	 * @param projectPath full project path or numeric id
	 * @param jobId the job id
	 */
	@func()
	async getJobCommitDiff(projectPath: string, jobId: string | number): Promise<string> {
		if (!projectPath) throw new Error('Parameter "projectPath" must be truthy');
		if (!jobId) throw new Error('Parameter "jobId" must be truthy');

		const project = await this.api().Projects.show(projectPath);
		const job = await this.api().Jobs.show(project.id, Number(jobId));

		const diffSchemas: CommitDiffSchema[] = await this.api().Commits.showDiff(projectPath, job.commit.id);
		let commitDiff = `<commit id="${job.commit.short_id}" author="${job.commit.author_name} - ${job.commit.author_email}">\n<commit:title>${job.commit.title}</commit:title>\n<commit:description>\n${job.commit.message}\n</commit:description>\n`;

		commitDiff += `${this.formatDiffs(diffSchemas)}</commit>`;
		const tokens = await countTokens(commitDiff);
		logger.info({ projectId: projectPath, jobId, tokens }, `Retrieved job commit diff (${tokens} tokens)`);
		return commitDiff;
	}

	/**
	 * Gets the logs for a CI/CD job
	 * @param projectIdOrProjectPath GitLab projectId. Either the full path (group(s) and project id) or the numeric id
	 * @param jobId the job id. Can get this from a job URL in the format https://<gitlab-host>/<group>/[<sub-group>/]<project>/-/jobs/<jobId>
	 */
	@func()
	async getJobLogs(projectIdOrProjectPath: string | number, jobId: string | number): Promise<string> {
		if (!projectIdOrProjectPath) throw new Error('Parameter "projectIdOrProjectPath" must be truthy');
		if (!jobId) throw new Error('Parameter "jobId" must be truthy');

		const project = await this.api().Projects.show(projectIdOrProjectPath);
		const job = await this.api().Jobs.show(project.id, Number(jobId));

		const logs = await this.api().Jobs.showLog(project.id, job.id);
		const tokens = await countTokens(logs);
		logger.info({ projectId: projectIdOrProjectPath, jobId, tokens }, `Retrieved job logs (${tokens} tokens)`);

		return logs;
	}

	async findDiscussionIdByNoteId(projectId: string | number, mergeRequestIid: number, noteId: number): Promise<DiscussionSchema | null> {
		const discussions = await this.api().MergeRequestDiscussions.all(projectId, mergeRequestIid);
		for (const d of discussions) {
			if (d.notes?.some((n: any) => n.id === noteId)) return d;
		}
		return null;
	}

	/**
	 * Gets the list of branches for a given GitLab project.
	 * @param projectId The full project path (e.g., 'group/subgroup/project') or the numeric project ID.
	 * @returns A promise that resolves to an array of branch names.
	 */
	@func()
	async getBranches(projectId: string | number): Promise<string[]> {
		try {
			// The Gitbeaker library handles pagination internally for `all()` methods
			const branches: BranchSchema[] = await this.api().Branches.all(projectId);
			return branches.map((branch) => branch.name);
		} catch (error) {
			logger.error(error, `Failed to get branches for GitLab project ${projectId}`);
			throw new Error(`Failed to get branches for ${projectId}: ${error.message}`);
		}
	}

	/**
	 * Retrieves the raw contents of a single file from a GitLab repository using a web UI blob URL.
	 *
	 * @param url The GitLab blob URL in the format: https://<host>/<project-path>/-/blob/<ref>/<file-path>
	 *            Example: https://gitlab.internal.company.com/engineering/services/user-service/-/blob/main/src/model/user.ts
	 * @returns The raw file contents as a string
	 * @throws Error if the URL format is invalid or the file cannot be retrieved
	 */
	@func()
	async getSingleFileContents(url: string): Promise<string> {
		const blobMarker = '/-/blob/';
		const blobIndex = url.indexOf(blobMarker);

		if (blobIndex === -1)
			throw new Error(`Invalid GitLab blob URL format. Expected format: https://<host>/<project-path>/-/blob/<ref>/<file-path>. Received: ${url}`);

		// Extract project path (everything between https://<host>/ and /-/blob/)
		const urlBeforeBlob = url.substring(0, blobIndex);
		const hostEndIndex = urlBeforeBlob.indexOf('/', 8); // Skip 'https://'

		if (hostEndIndex === -1) throw new Error(`Could not extract project path from URL: ${url}`);

		const projectPath = urlBeforeBlob.substring(hostEndIndex + 1);

		// Extract ref and file path (everything after /-/blob/)
		const afterBlob = url.substring(blobIndex + blobMarker.length);
		const refEndIndex = afterBlob.indexOf('/');

		if (refEndIndex === -1) throw new Error(`Could not extract ref and file path from URL: ${url}`);

		const ref = afterBlob.substring(0, refEndIndex);
		const filePath = afterBlob.substring(refEndIndex + 1);

		if (!projectPath || !ref || !filePath) throw new Error(`Failed to parse GitLab URL. Project: "${projectPath}", Ref: "${ref}", File: "${filePath}"`);

		logger.info({ projectPath, ref, filePath }, 'Fetching file contents from GitLab');
		try {
			const contents = await this.api().RepositoryFiles.showRaw(projectPath, filePath, ref);
			return Buffer.isBuffer(contents) ? contents.toString('utf-8') : (contents as string);
		} catch (error: any) {
			logger.error({ error }, `Failed to fetch file from GitLab: ${projectPath}/${filePath}@${ref} - ${error.message}`);
			throw new Error(`Failed to fetch file from GitLab: ${projectPath}/${filePath}@${ref} - ${error.message}`);
		}
	}

	// 	/**
	// 	 *
	// 	 * @param from The start of the time range to get events for
	// 	 * @param to The end of the time range to get events for
	// 	 * @returns the activity for the user on the given day
	// 	 */
	// 	async getUserActivity(day: Date): Promise<EventSchema[]> {
	// 		console.log(`getUserActivity ${day}`)
	// 		const user = await this.api().Users.showCurrentUser();
	// console.log(user)
	// 		// midnight UTC of the requested local day
	// 		const startUTC = new Date(Date.UTC(day.getFullYear(),
	// 											day.getMonth(),
	// 											day.getDate() - 1));          // 2025-07-22T00:00:00Z
	// 		const endUTC   = new Date(startUTC.getTime() + 86_400_000);   // +1 day

	// 		const after  = yyyymmddUTC(startUTC);   // 2025-07-22
	// 		const before = yyyymmddUTC(endUTC);     // 2025-07-23

	// 		console.log('gitlab', after, before);   // now prints 2025-07-22 2025-07-23
	// 		console.log(startUTC.toISOString(), endUTC.toISOString());
	// 		// const activity = await this.api().Users.allEvents(user.id, { after: startUTC.toISOString(), before: endUTC.toISOString() });
	// 		// const aiAcitivity = await this.api().Users.allEvents(67, { after, before, scope: 'all' });
	// 		const userAcitivity = await this.api().Users.allEvents(10, { after: '2025-02-01', before: '2025-02-30', scope: 'all' });
	// 		// console.log(userAcitivity);

	// 		// await this.api().Events.all({ after: '2024-07-01', before: '2024-07-30', scope: 'all' });
	// 		// const activity = await this.api().Users.allEvents(user.id, { after: '2025-06-20', before: '2025-07-23' });

	// 		return [...userAcitivity];
	// 	}

	/**
	 * @see https://docs.gitlab.com/api/events/#get-contribution-events-for-a-user
	 * @param date The day to get activity for.
	 * @returns the activity for the user on the given day
	 */
	async getUserActivity(date: Date): Promise<EventSchema[]> {
		date.setDate(date.getDate() + 1);
		// Get the start and end times of the day for after/from to before/to
		const startOfDay = new Date(date);
		startOfDay.setHours(0, 0, 0, 0);
		startOfDay.setDate(date.getDate() - 1);
		const endOfDay = new Date(date);
		endOfDay.setHours(23, 59, 59, 999);

		const user = await this.api().Users.showCurrentUser();

		const activity = await this.api().Users.allEvents(user.id, { after: startOfDay.toISOString(), before: endOfDay.toISOString() });
		return activity;
	}

	/**
	// async getUserActivity2(day: Date): Promise<EventSchema[]> {
	// 	const user = await this.api().Users.showCurrentUser();

	// 	// 00:00-24:00 UTC of the required calendar day
	// 	const after = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())).toISOString(); // 2025-07-22T00:00:00Z
	// 	const before = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate() + 1)).toISOString(); // 2025-07-23T00:00:00Z

	// 	console.log(day);
	// 	console.log(after);
	// 	console.log(before);
	// 	return this.api().Users.allEvents(user.id, {
	// 		after,
	// 		before,
	// 		scope: 'all', // <- include both “created” and “authored”
	// 		perPage: 100, // optional, raises the page size
	// 	});
	// }

	/**
	 * Returns the type of this SCM provider.
	 */
	getScmType(): 'gitlab' {
		return 'gitlab';
	}
}

/**
 * Convert any Date to a YYYY-MM-DD string representing the same day
 * in UTC, regardless of the machine’s local time-zone.
 */
function yyyymmddUTC(date: Date): string {
	const y = date.getUTCFullYear();
	const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
	const d = date.getUTCDate().toString().padStart(2, '0');
	return `${y}-${m}-${d}`;
}
