import { LoadingRows } from "./states";

/** Body of every route's loading.tsx. */
export function RouteLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="page">
      <LoadingRows rows={rows} label={label} />
    </div>
  );
}
