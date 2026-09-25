import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LicensesApp from "./LicensesApp";
import "../home.css";
import "../legal.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LicensesApp />
  </StrictMode>,
);
