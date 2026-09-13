import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex h-full min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="label">Nothing under this cloche</p>
      <h1 className="display text-4xl">404</h1>
      <Link href="/" className="btn btn-gold">
        Back to the table
      </Link>
    </main>
  );
}
