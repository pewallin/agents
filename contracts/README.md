# Contracts with Agents Next

Agents Next decodes these outputs of the CLI with its own Swift types. Each has a JSON
Schema and an example here:

| Output | Schema | Read by the app in |
|---|---|---|
| `$AGENTS_HOME/runtime/state-events.jsonl`, one event per line | `runtime-state-event.schema.json` | `AgentsRuntimeWatchEventLineDecoder` |
| `agents ls --json --no-interactive` | `ls.schema.json` | `AgentsListInventoryParser` |
| `agents done list\|record\|update --json` | `done.schema.json` | `AgentRecentDoneProjection` |
| `agents history --json` | `history.schema.json` | `AgentSessionHistoryParser` |

The same folder is in the app repository (pewallin/agents-next, `contracts/`) and must stay
identical: a release of the app refuses to bundle a CLI whose `contracts/` differs.

- `src/contracts.test.ts` checks that what the CLI writes fits the schemas (no field missing,
  none unknown, types and values as named) and that each example fits its schema and shows
  every field.
- The app's tests decode the examples with the app's own types and check that it knows every
  value a schema allows: `CLIContractTests` (AgentsCore: ls, done),
  `CLIRuntimeEventContractTests` (AgentsAppCore) and `CLIHistoryContractTests` (AgentsNextTests).

Changing a field: change the CLI, the schema and the example here, copy `contracts/` to the
app, make the app's contract tests pass there, then bump `agents-cli.lock`.
