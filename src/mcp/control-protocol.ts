export const CONTROL_PROTOCOL_VERSION = 1;

export type ControlIdentity = { profileId: string; instanceId: string };
export type AcquireControlRequest = ControlIdentity & { id: string; pid: number; label: string };
export type OwnedControlRequest = ControlIdentity & { controllerId: string };
export type ControllerSummary = { pid: number; label: string; activeActions: number; releasing: boolean };
