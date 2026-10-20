import { signOut } from "@/lib/auth";

export function Top({ label, signedIn = false }: { label: string; signedIn?: boolean }) {
  return (
    <header className="top">
      <div className="brand"><small>{label}</small>FoodLG</div>
      <div className="row" style={{ gap: 8 }}>
        <span className="synthetic">Test version · synthetic data only</span>
        {signedIn && <form action={signOut}><button className="ghost" type="submit">Sign out</button></form>}
      </div>
    </header>
  );
}
