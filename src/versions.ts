import manifest from "../package.json" with { type: "json" };

export const STELZ_VERSION = manifest.version;
export const UPSTREAM_VERSION = manifest.dependencies["@askjo/camofox-browser"];
export const MCP_SDK_VERSION = manifest.dependencies["@modelcontextprotocol/sdk"];
export const COMMIT = "31376c27db94204ffdc635ae71a7f61328e91a5e";
