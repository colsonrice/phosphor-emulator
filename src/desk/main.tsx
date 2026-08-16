import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PermissionDesk from "./PermissionDesk";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PermissionDesk />
  </StrictMode>,
);
