// .config.example.yaml is the single source of truth for `elseagent init`.
// Imported as text so it is embedded in the compiled single-file build.
import template from "../../.config.example.yaml" with { type: "text" };

// bun-types declares *.yaml imports as parsed objects; with `type: "text"` it is the raw string.
export const CONFIG_TEMPLATE = template as unknown as string;
