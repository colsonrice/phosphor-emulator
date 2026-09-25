import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PrivacyApp from "./PrivacyApp";
import "../home.css";
import "../legal.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PrivacyApp />
  </StrictMode>,
);
