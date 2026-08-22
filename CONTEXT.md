# Goal workflow

This context defines the language for persistent objectives on BB agent threads.

## Language

**Goal**:
A durable objective instance attached to a thread. A thread may have many Goals over time but only one unfinished Goal at once.
_Avoid_: Task, job, prompt

**Active Goal**:
The unfinished Goal currently governing a thread. While active, it causes the thread to keep taking turns until it reaches a stopping state.
_Avoid_: Current prompt, running task

**Goal turn**:
A turn that pursues the active Goal, whether started by the user or automatically continued by the plugin.
_Avoid_: Retry, loop iteration

**Continuation**:
An automatically started Goal turn after the thread becomes idle while its Goal remains active.
_Avoid_: Retry

**Completion**:
A stopping state that claims current evidence proves the full Goal objective is satisfied and no required work remains.
_Avoid_: Done response, successful turn

**Blockage**:
A stopping state reached only when the same external blocker prevents meaningful progress for the required consecutive Goal turns.
_Avoid_: Difficulty, uncertainty, clarification request

**Goal history**:
The ordered record of Goal instances previously attached to a thread, including their objectives, final states, and usage metadata.
_Avoid_: Prompt history, conversation history

**Usage limit**:
A provider restriction that prevents another Goal turn. A known subscription reset may resume automatically; credit and spend-control limits require manual resumption.
_Avoid_: Goal budget, blockage

**Pause**:
A reversible user or system stop that prevents Continuations without ending the Goal. It does not interrupt a Goal turn already running.
_Avoid_: Cancellation, blockage

**Cancellation**:
An irreversible user decision to stop an unfinished Goal while retaining it in Goal history.
_Avoid_: Pause, deletion, completion
