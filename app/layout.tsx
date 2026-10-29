export const metadata = { title: "Haq", description: "Your AI that calls customer care for you" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
