import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LibraryApp } from "../App";
import "../styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LibraryApp />
  </StrictMode>,
);
