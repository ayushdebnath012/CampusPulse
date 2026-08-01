export const metadata = {
  title: "CampusPulse",
  description: "Professor-owned courses, teaching-team attendance, and quick quizzes.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
