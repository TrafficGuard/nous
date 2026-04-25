<a id="banner"></a>
<p align="center">
  <img src="https://public.trafficguard.ai/typedai/banner.png" alt="TypedAI banner"/>
</p>
<p align="center">
  <em >The TypeScript-first AI platform for developers</em><br/>
  <small>Autonomous AI agents and LLM based workflows</small>
</p>

## Documentation site
[Home](https://typedai.dev/) |  [Setup](https://typedai.dev/setup/) | [Observability](https://typedai.dev/observability/) | [Function calling](https://typedai.dev/functions/) | 
[Autonomous AI Agent](https://typedai.dev/autonomous-agents/) | [AI Software Engineer](https://typedai.dev/software-engineer/) | [AI Code reviews](https://typedai.dev/code-review/) |
[Tools/Integrations](https://typedai.dev/integrations/) | [Roadmap](https://typedai.dev/roadmap/)

---

[Features](#key-features) | [UI Examples](#ui-examples) | [Code examples](#code-examples) | [Contributing](#contributing)

TypedAI is a full-featured platform for developing and running agents, LLM based workflows and chatbots.

Included are capable software engineering agents, which have assisted building the platform.

## Key features

- [Advanced Autonomous agents](https://typedai.dev/autonomous-agents)
- [Software developer agents](https://typedai.dev/software-engineer/)
- [Pull request code review agent](https://typedai.dev/code-review/)
- [AI chat interface](https://typedai.dev/chat/)
- [Slack chatbot](https://typedai.dev/chatbot/)
- Supports many LLM services - OpenAI, Anthropic (native & Vertex), Gemini, Groq, Fireworks, Together.ai, DeepSeek, Ollama, Cerebras, SambaNova, OpenRouter, X.ai
- Multi-agent [extend-reasoning implementations](https://github.com/TrafficGuard/typedai/tree/main/src/llm/multi-agent) of the LLM interface
- Configurable Human-in-the-loop settings
- [Functional callable tools/integrations](https://typedai.dev/integrations/) (Filesystem, Jira, Slack, Perplexity, Google Cloud, Gitlab, GitHub etc)
- CLI and Web UI interface
- Run locally or deployed on the cloud with multi-user/SSO
- OpenTelemetry based observability
- Leverages the extensive Python AI ecosystem through executing Python scripts/packages

## CLI Usage

TypedAI provides powerful command-line tools for automation and development workflows:

```bash
# Quick examples using the ai wrapper script
ai query "What test frameworks does this repository use?"
ai code "Add error handling to the user authentication function"  
ai research "Latest developments in large language models"
```

The `ai` script runs locally while `aid` runs in Docker for isolation. Both provide access to all CLI agents including the specialized `codeAgent` for autonomous code editing tasks.

For comprehensive CLI documentation, see the [CLI Usage Guide](https://typedai.dev/cli-usage/).

## Autonomous agents

- Reasoning/planning inspired from Google's [Self-Discover](https://arxiv.org/abs/2402.03620) and other papers
- Memory and function call history for complex workflows
- Iterative planning with hierarchical task decomposition
- Sandboxed execution of generated code for multi-step function calling and logic
- LLM function schemas auto-generated from source code
- Human-in-the-loop for budget control, agent initiated questions and error handling

More details at the [Autonomous agent docs](https://typedai.dev/autonomous-agents)

## Software developer agents

- Code Editing Agent for local repositories
  - Auto-detection of project initialization, compile, test and lint
  - Task file selection agent selects the relevant files
  - Design agent creates the implementation plan.
  - Code editing loop with compile, lint, test, fix
    - Compile error analyser can search online, add additional files and install packages
  - Final review of the changes with an additional code editing loop if required.
- Software Engineer Agent (For ticket to Pull Request workflow):
  - Find the appropriate repository from GitLab/GitHub
  - Clone and create branch
  - Call the Code Editing Agent
  - Create merge request
- Code Review agent:
  - Configurable code review guidelines
  - Posts comments on GitLab merge requests at the appropriate line with suggested changes
- Repository ad hoc query agent
- Codebase awareness - optional index creation used by the task file selection agent

More details at the [Software developer agents](https://typedai.dev/software-engineer/) docs.

## Flexible run/deploy options

- Run from the repository or the provided Dockerfile in single user mode.
- CLI interface
- Web interface
- Scale-to-zero deployment on Firestore & Cloud Run
- Multi-user SSO enterprise deployment (with [Google Cloud IAP](https://cloud.google.com/security/products/iap))
- Terraform, infra scripts and more authentication options coming soon.

## UI Examples

### List agents

![List agents](https://public.trafficguard.ai/typedai/agent-list.png)

### New Agent

![New Agent UI](https://public.trafficguard.ai/typedai/agent-new.png)

### Agent error handling

![Feedback requested](https://public.trafficguard.ai/typedai/agent-feedback.png)

### Agent LLM calls

![Agent LLM calls](https://public.trafficguard.ai/typedai/agent-llm-calls.png)

### Sample trace (Google Cloud)

![Sample trace in Google Cloud](https://public.trafficguard.ai/typedai/trace.png)

### Human in the loop notification

<img src="https://public.trafficguard.ai/typedai/feedback.png" width="702">

### Code review configuration

![Code review configuration](https://public.trafficguard.ai/typedai/code-reviews.png)

### AI Chat

![AI chat](https://public.trafficguard.ai/typedai/chat.png)

### User profile

![Profile](https://public.trafficguard.ai/typedai/profile1.png)
![Profile](https://public.trafficguard.ai/typedai/profile2.png)

Default values can also be set from environment variables.

## Code Examples

### TypedAI vs LangChain

TypedAI doesn't use LangChain, for [many reasons](https://www.octomind.dev/blog/why-we-no-longer-use-langchain-for-building-our-ai-agents) that [you](https://www.google.com/search?q=langchain+site%3Anews.ycombinator.com) can [read](https://www.reddit.com/r/LangChain/comments/1gmfyi2/why_are_people_hating_langchain_so_much/) [online](https://www.google.com/search?q=langchain+sucks+site%3Areddit.com)

The scope of the TypedAI platform covers functionality found in LangChain and LangSmith.

Let's compare the LangChain document example for Multiple Chains to the equivalent TypedAI implementation.

#### LangChain
```typescript
import { PromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { ChatAnthropic } from "@langchain/anthropic";

const prompt1 = PromptTemplate.fromTemplate(
  `What is the city {person} is from? Only respond with the name of the city.`
);
const prompt2 = PromptTemplate.fromTemplate(
  `What country is the city {city} in? Respond in {language}.`
);

const model = new ChatAnthropic({});

const chain = prompt1.pipe(model).pipe(new StringOutputParser());

const combinedChain = RunnableSequence.from([
  {
    city: chain,
    language: (input) => input.language,
  },
  prompt2,
  model,
  new StringOutputParser(),
]);

const result = await combinedChain.invoke({
  person: "Obama",
  language: "German",
});

console.log(result);
```

#### TypedAI
```typescript
import { runAgentWorkflow } from '#agent/agentWorkflowRunner';
import { anthropicLLMs } from '#llms/anthropic'

const cityFromPerson = (person: string) => `What is the city ${person} is from? Only respond with the name of the city.`;
const countryFromCity = (city: string, language: string) => `What country is the city ${city} in? Respond in ${language}.`;

runAgentWorkflow({ llms: anthropicLLMs() }, async () => {
  const city = await llms().easy.generateText(cityFromPerson('Obama'));
  const country = await llms().easy.generateText(countryFromCity(city, 'German'));

  console.log(country);
});
```

The TypedAI code also has the advantage of static typing with the prompt arguments, enabling you to refactor with ease.
Using simple control flow allows easy debugging with breakpoints/logging.

To run a fully autonomous agent:

```typescript
startAgent({
  agentName: 'Create ollama',
  initialPrompt: 'Research how to use ollama using node.js and create a new implementation under the llm folder. Look at a couple of the other files in that folder for the style which must be followed',
  functions: [FileSystem, Perplexity, CodeEditinAgent],
  llms,
});
```

### Automated LLM function schemas

LLM function calling schema are automatically generated by having the `@func` decorator on class methods, avoiding the
definition duplication using zod or JSON.

```typescript
@funcClass(__filename)
export class Jira {
    instance: AxiosInstance | undefined;
    
    /**
     * Gets the description of a JIRA issue
     * @param {string} issueId - the issue id (e.g. XYZ-123)
     * @returns {Promise<string>} the issue description
     */
    @func()
    async getJiraDescription(issueId: string): Promise<string> {
        if (!issueId) throw new Error('issueId is required');
        const response = await this.axios().get(`issue/${issueId}`);
        return response.data.fields.description;
    }
}
```

## Contributing

We warmly welcome contributions to the project through [issues](https://github.com/TrafficGuard/typedai/issues), [pull requests](https://github.com/TrafficGuard/typedai/pulls)  or [discussions](https://github.com/TrafficGuard/typedai/discussions)

## ❓ FAQ

### What is TypedAI?

TypedAI is a TypeScript AI platform featuring:
- **AI Chat**: Conversational interface with multiple LLM providers
- **Autonomous Agents**: Self-directed AI agents that can perform complex tasks
- **Software Developer Agents**: AI-powered coding assistants for code review, generation, and more
- **Flexible Deployment**: Run locally or deploy to cloud platforms

### Which LLM providers are supported?

TypedAI supports multiple LLM providers including:
- **OpenAI**: GPT-4o, GPT-4, GPT-3.5 Turbo
- **Anthropic**: Claude models
- **Local models**: Via compatible APIs
- **Custom endpoints**: Any OpenAI-compatible API

Configure your provider in the agent settings or environment variables.

### How do I set up autonomous agents?

1. **Create an Agent**: Use the UI or CLI to define a new agent with a specific goal
2. **Configure Tools**: Assign tools the agent can use (file operations, web search, code execution, etc.)
3. **Set Constraints**: Define boundaries and rules for the agent's behavior
4. **Run**: Start the agent and monitor its progress through the UI

See the [Code Examples](#code-examples) section for agent configuration samples.

### What is the difference between Autonomous Agents and Developer Agents?

- **Autonomous Agents**: General-purpose agents that can perform a wide range of tasks based on their configuration and tools. They operate independently to achieve defined goals.
- **Developer Agents**: Specialized agents focused on software development tasks like code review, bug detection, code generation, and documentation. They have developer-specific tools and knowledge.

### How do I deploy TypedAI?

TypedAI offers flexible deployment options:
- **Local Development**: Run with `npm run dev` for development
- **Docker**: Containerized deployment for consistent environments
- **Cloud**: Deploy to any Node.js-compatible platform (Vercel, Railway, etc.)

### Can I use TypedAI with my own API keys?

Yes! TypedAI is designed to work with your own API keys. Configure your provider's API key in:
- Environment variables (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`)
- Agent-specific settings in the UI
- Configuration files

### How do I contribute to TypedAI?

Contributions are welcome! Key areas:
- New agent types and capabilities
- Additional LLM provider integrations
- UI/UX improvements
- Bug fixes and performance optimizations
- Documentation and examples

### Where can I get help?

- **GitHub Issues**: [Report bugs or request features](https://github.com/TrafficGuard/typedai/issues)
- **Discussions**: [Join the community](https://github.com/TrafficGuard/typedai/discussions)
