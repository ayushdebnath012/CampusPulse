export const metadata = {
  title: "CampusPulse",
  description: "Classroom attendance, quick quizzes, course access, and ERP sync.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
