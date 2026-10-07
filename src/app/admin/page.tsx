import { redirect } from "next/navigation";

/** /admin adalah alias ke dashboard — guard role ada di layout segmen ini. */
export default function AdminIndexPage() {
  redirect("/admin/dashboard");
}
