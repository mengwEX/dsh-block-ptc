/** Model-facing block usage, shared by system guidance and tool schemas. */
export const HEADER_GUIDANCE = 'Every run_code call, including the first, must use description "[block: <ids>] <goal>". Replace <ids> with the block ids and <goal> with the purpose of this operation. Separate multiple ids with commas; ids must be non-empty, unique, and contain no commas, brackets or line breaks.'

export const CONTENT_GUIDANCE = 'Organize the complete content from the first occurrence to the last occurrence of these ids. Preserve information still needed for subsequent work in full, with enough detail to continue directly. Briefly summarize information no longer needed, and omit irrelevant or duplicate material. Preserve user requirements, corrections and constraints accurately. Record completed work, results, unfinished work and the next step.'

export const COMPACT_GUIDANCE = 'Compact a block when its content is no longer needed, or its results have already been reported to the user and you are moving on to other work. Keep content still needed for upcoming execution, replies or discussion. Do not compact merely because a work step has finished.'

export const RULES = `## Block mode

Call the built-in \`run_code\` tool directly. Call other tools through the \`tools.*\` SDK inside its program.

\`run_code({ description: "[block: <ids>] <goal>", code })\`

${HEADER_GUIDANCE}

Organize blocks around relatively independent units of work. Reuse an id while continuing the same work.

### Compacting a block

${COMPACT_GUIDANCE}

Call \`await tools.block_compact({ ids, content })\` from inside a program.

- \`ids\` — the block ids to organize and close.
- \`content\` — required, written by you. ${CONTENT_GUIDANCE}

An earlier \`<block-summary>\` contains information you retained from earlier work. Use that information to continue the current task. If it lists block ids, those are its remaining block memberships.`

/** Keep native SDK declarations while aligning its transport examples with block mode. */
function blockSdk(text) {
  return text.replace(/`run_code\(\{[^\r\n]*\}\)`/g,
    '`run_code({ description: "[block: <ids>] <goal>", code })`') + `\n\n${HEADER_GUIDANCE}`
}

/** Adapt the provider-owned presentation; execution stays with the native PTC executor. */
export function createBlockExecutor(native) {
  return {
    sections: native.sections.map((section) => section.name !== 'tools:sdk' ? section : {
      ...section,
      text: (definitions) => blockSdk(typeof section.text === 'function' ? section.text(definitions) : section.text),
    }),
    describe(definitions) {
      const view = native.describe(definitions)
      return {
        ...view,
        schemas: view.schemas.map((tool) => tool.name !== 'run_code' ? tool : {
          ...tool,
          description: `${tool.description}\n\n${HEADER_GUIDANCE}`,
          parameters: {
            ...tool.parameters,
            properties: {
              ...tool.parameters.properties,
              description: { ...tool.parameters.properties.description, description: HEADER_GUIDANCE },
            },
          },
        }),
      }
    },
    execute: (input) => native.execute(input),
  }
}
