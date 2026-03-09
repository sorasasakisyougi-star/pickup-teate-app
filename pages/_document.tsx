import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="ja">
      <Head>
        <meta name="theme-color" content="#020817" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
      </Head>
      <body
        style={{
          margin: 0,
          padding: 0,
          background:
            "radial-gradient(circle at top, rgba(24,80,180,0.18), transparent 28%), linear-gradient(180deg, #020817 0%, #030712 100%)",
          color: "#fff",
          overflowX: "hidden",
        }}
      >
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
