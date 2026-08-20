import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LogoApp } from "./LogoApp";
import "../home.css";
import "./logo.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LogoApp />
  </StrictMode>,
);
