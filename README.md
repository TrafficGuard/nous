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

## FAQ

### What is TypedAI?

TypedAI is the TypeScript-first AI platform for developers. It provides autonomous AI agents and LLM-based workflows, including software engineering agents, code review agents, chatbots, and observability tools.

### How does TypedAI compare to LangChain or CrewAI?

- **TypedAI**: TypeScript-first, full platform with autonomous agents, software engineer agents, code review, chatbots, CLI + Web UI, multi-tenant SSO, OpenTelemetry observability
- **LangChain**: Chain-based orchestration library, requires more boilerplate for autonomous agents
- **CrewAI**: Role-playing multi-agent framework, focused on collaboration patterns

TypedAI uses simple control flow with static typing, avoiding the LangChain abstraction overhead. See the [TypedAI vs LangChain comparison](https://typedai.dev) in the README.

### What LLM providers does TypedAI support?

TypedAI supports multiple LLM services:
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude, native & Vertex)
- Google Gemini
- Groq (Llama, Mixtral)
- Fireworks
- Together.ai
- DeepSeek
- Ollama (local)
- Cerebras
- SambaNova
- OpenRouter
- X.ai (Grok)

### What are the key features of TypedAI agents?

- **Autonomous AI Agents**: Self-Discover reasoning, memory, function call history, hierarchical task decomposition
- **Software Engineer Agent**: Auto-detection of project init/compile/test/lint, task file selection, design planning, code editing loop with compile/lint/test/fix
- **Code Review Agent**: Configurable guidelines, posts comments on GitLab/GitHub merge requests with suggested changes
- **Chatbot**: Slack chatbot, AI chat interface

### How do I get started with TypedAI?

1. **Clone the repository**:
   ```bash
   git clone https://github.com/TrafficGuard/typedai.git
   cd typedai
   ```

2. **Run with Docker** (single user mode):
   ```bash
   docker build -t typedai .
   docker run -p 3000:3000 typedai
   ```

3. **CLI usage**:
   ```bash
   ai query "What test frameworks does this repository use?"
   ai code "Add error handling to the user authentication function"
   ```

### What deployment options are available?

- **Local**: Run from repository or Dockerfile in single user mode
- **CLI interface**: Command-line tools for automation
- **Web interface**: Browser-based UI
- **Cloud Run**: Scale-to-zero deployment on Firestore & Cloud Run
- **Enterprise**: Multi-user SSO deployment with Google Cloud IAP

### What integrations/tools are available?

TypedAI provides functional callable tools:
- Filesystem
- Jira
- Slack
- Perplexity
- Google Cloud
- GitLab
- GitHub
- Custom tools via `@func` decorator

### How does the autonomous agent reasoning work?

TypedAI autonomous agents use reasoning/planning inspired from Google's [Self-Discover](https://arxiv.org/abs/2402.03620):
- Memory and function call history
- Iterative planning with hierarchical task decomposition
- Sandboxed execution of generated code
- LLM function schemas auto-generated from source code
- Human-in-the-loop for budget control and error handling

### What observability features are available?

TypedAI provides OpenTelemetry-based observability:
- Traces for agent LLM calls
- Metrics for performance monitoring
- Sample traces viewable in Google Cloud

### How do I create custom tools?

Use the `@func` decorator on class methods:

```typescript
@funcClass(__filename)
export class MyTools {
    @func()
    async myFunction(param: string): Promise<string> {
        // Implementation
    }
}
```

### Where can I find help?

- [Documentation](https://typedai.dev/)
- [Setup Guide](https://typedai.dev/setup/)
- [Autonomous Agents](https://typedai.dev/autonomous-agents/)
- [GitHub Issues](https://github.com/TrafficGuard/typedai/issues)
- [GitHub Discussions](https://github.com/TrafficGuard/typedai/discussions)
