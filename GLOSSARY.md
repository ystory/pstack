# pstack execution

The language used to distinguish coordination, delegated work, and the application in which pstack runs.

## Language

**Orchestrator**:
The agent responsible for interpreting the user's goal, assigning work, judging results, and integrating the outcome.
_Avoid_: Worker, model provider

**Worker**:
An agent assigned a bounded task by the orchestrator.
_Avoid_: Orchestrator, model

**Worker executor**:
The runtime that executes a pstack worker, independently of the host in which pstack was invoked.
_Avoid_: pstack host, model family

**Worker role**:
A named responsibility within a pstack workflow, independent of the model selected to perform it.
_Avoid_: Model name, executor

**Role configuration**:
The user's current model and execution preferences for a worker role. Each pstack host has its own choices, which the user can change through setup.
_Avoid_: Permanent role assignment

**pstack host**:
The application in which the user invokes pstack and the orchestrator runs.
_Avoid_: Model, worker executor

**Host distribution**:
A separately installable pstack package for a particular pstack host.
_Avoid_: Shared installation
