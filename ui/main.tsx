import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "./styles.css";
import { App } from "./App";
import { bootstrapSession } from "./api";

// Consume the fragment synchronously, before any request or React work.
const session = bootstrapSession();
createRoot(document.getElementById("root")!).render(<App session={session} />);
