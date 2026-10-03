import { appDeployment, appNetworkLabel, factoryOf, REPO_URL } from "@/lib/config";
import { AddressLink } from "../ui";
import s from "./layout.module.css";

export function Footer() {
  const factory = factoryOf(appDeployment);
  return (
    <footer className={s.footer}>
      <div className={s.footerInner}>
        <div className={s.footerGroup}>
          <span>Hunch Book</span>
          <span>Status: building</span>
          <span>Network: {appNetworkLabel}</span>
          <span>
            Factory:{" "}
            {factory ? <AddressLink address={factory} /> : <span className="subtle">not deployed yet</span>}
          </span>
        </div>
        <div className={s.footerGroup}>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            Source on GitHub
          </a>
          <a href={`${REPO_URL}/blob/main/docs/PROTOCOL.md`} target="_blank" rel="noreferrer">
            Protocol
          </a>
        </div>
      </div>
    </footer>
  );
}
