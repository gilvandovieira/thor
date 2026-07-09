#!/usr/bin/env node
/**
 * Thor migration CLI (spec §2.2, §13.2). Binary name: `thor`.
 *
 * Parses process arguments, dispatches commands, and converts thrown failures
 * into user-facing stderr messages and a non-zero exit code.
 *
 * @module cli
 */
import * as commands from "./commands.js"

const HELP = `thor — Effect-native database toolkit CLI

Usage: thor <command> [args]

Commands:
  init              Create config, migrations folder, and journal
  create <name>     Create an empty/manual migration
  generate <name>   Diff current schema vs previous snapshot
  check             Validate schema, migration order, destructive operations
  status            Show applied/pending migrations
  up                Apply pending migrations
  down              Roll back the last migration
  redo              Down then up the last migration
  drift             Compare database state vs expected schema
  snapshot          Write a schema snapshot without migrating
  pull              Introspect a live DB into schema/snapshot
`

/**
 * @returns Nothing. Dispatches the command represented by `process.argv`.

 */
const main = (): void => {
  const [command, ...rest] = process.argv.slice(2)
  const cwd = process.cwd()

  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP)
      return
    case "init":
      return commands.init(cwd)
    case "create":
      return commands.create(cwd, rest[0] ?? "")
    case "status":
      return commands.status(cwd)
    case "check":
      return commands.check(cwd)
    case "generate":
      return commands.generate()
    case "up":
      return commands.up()
    case "down":
      return commands.down()
    case "redo":
      return commands.redo()
    case "drift":
      return commands.drift()
    case "snapshot":
      return commands.snapshot()
    case "pull":
      return commands.pull()
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`)
      process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`Error: ${(error as Error).message}\n`)
  process.exitCode = 1
}
