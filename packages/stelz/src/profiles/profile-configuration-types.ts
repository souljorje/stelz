export type NetworkUpdate = {
  revision: string;
  mode: "direct" | "proxy";
  proxyUrl?: string;
  expectedIp?: string;
};

export type ProfileCreate = {
  revision: string;
  id: string;
  proxyUrl?: string;
  expectedIp?: string;
};
