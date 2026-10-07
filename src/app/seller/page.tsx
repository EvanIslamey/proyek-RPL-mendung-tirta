import { redirect } from "next/navigation";

/** /seller adalah alias ke dashboard — guard role ada di layout segmen ini. */
export default function SellerIndexPage() {
  redirect("/seller/dashboard");
}
