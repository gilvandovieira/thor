#!/usr/bin/env node
/**
 * Thor database toolkit CLI (spec §2.2, §13.2, v1 §20.3). Binary name: `thor`.
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
  capabilities <dialect|runtime>
                    Print postgres/sqlite/mysql or runtime capability statuses
  skills <list|export>
                    List or export Thor LLM skills (--to <dir>, --format md|json)
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
    case "capabilities":
      return commands.capabilities(rest)
    case "skills":
      return commands.skills(cwd, rest)
    default:
      process.stderr.write(`Unsupported command: ${command}.\n\n${HELP}`)
      process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`Error: ${(error as Error).message}\n`)
  process.exitCode = 1
}
