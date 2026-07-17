import { Icon, type IconName } from "./icons";

/** 이번 슬라이스에서 아직 구현하지 않은 화면용 "준비 중" 플레이스홀더 */
export default function Placeholder({
  icon,
  title,
  description,
}: {
  icon: IconName;
  title: string;
  description: string;
}) {
  return (
    <div className="ws-placeholder">
      <div className="ws-placeholder-icon">
        <Icon name={icon} size={30} />
      </div>
      <h1>{title}</h1>
      <p>{description}</p>
      <span className="ws-placeholder-badge">준비 중</span>
    </div>
  );
}
