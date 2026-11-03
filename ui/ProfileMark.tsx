import { profileAppearance } from "../src/profile-appearance";

export function ProfileMark({ id }: { id: string }) {
  const appearance = profileAppearance(id);
  return <svg className="profile-mark" viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">
    <rect width="26" height="26" rx="5" fill={appearance.color} />
    <text x="13" y="17" textAnchor="middle" fill="#fff">{appearance.badge}</text>
  </svg>;
}
