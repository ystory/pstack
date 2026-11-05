# Privacy notice

Last updated: 2026-10-15

This notice covers the unofficial pstack-for-codex distribution maintained at [ystory/pstack](https://github.com/ystory/pstack). Codex, Claude Code, GitHub, and other services have their own privacy policies and account settings.

## Information used and where it goes

- Setup reads available model and CLI capabilities and stores model preferences, managed agent files, configuration blocks, and ownership records locally under your Codex home. These support agent registration and model routing.
- Tasks may use your prompts, source code, selected instructions, context files, and relevant conversation history. Codex and the selected model executor process this information to perform the requested work. The Claude runner supplies task text and selected context to your existing Claude Code CLI, which uses its configured provider and authentication. Running a local executor does not mean model processing stays on your device.
- Workflows can use configured tools, MCP connections, and connected services. For example, a GitHub workflow can read or publish repository and PR content. Dependency installation can contact package registries. Information sent to these services depends on the workflow and your tool permissions and configuration.
- Local run output and receipts can include prompts, instructions, file paths, model responses, and tool results. They are stored in the selected output directories for execution, review, and resumption.
- If you open a public [support issue](https://github.com/ystory/pstack/issues), GitHub, the maintainers, and other visitors can read the information you post. It is used to investigate and respond to the report.

## Retention and your controls

Local configuration and run files remain until you delete them or the relevant tool removes them. Unregistering the plugin's managed agents leaves saved model preferences in place. There is no general automatic deletion of run receipts.

Model providers, connected services, registries, and GitHub apply their own retention policies and account controls. The distribution's maintainers do not control their retention periods.

You can choose model roles and connected tools, limit the context supplied to a task, change tool permissions, remove local run files, and uninstall the plugin. Use the relevant provider's controls for information already sent to that service. For questions about this notice, contact the maintainers through [GitHub issues](https://github.com/ystory/pstack/issues); keep private task data and credentials out of public reports.
