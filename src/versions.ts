import manifest from "../package.json" with { type: "json" };

export const STELZ_VERSION = manifest.version;
export const UPSTREAM_VERSION = manifest.dependencies["@askjo/camofox-browser"];
export const MCP_SDK_VERSION = manifest.dependencies["@modelcontextprotocol/sdk"];
export const COMMIT = "39c82094013480b373df6600d44c7f036f58356e";
