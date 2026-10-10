import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { WalletProvider, useWallet } from "./context/WalletContext";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Escrows from "./pages/Escrows";
import EscrowDetail from "./pages/EscrowDetail";
import CreateEscrow from "./pages/CreateEscrow";
import Disputes from "./pages/Disputes";
import Events from "./pages/Events";
import Account from "./pages/Account";
import Admin from "./pages/Admin";
import "./styles.css";

/** Client-side route guard; the contracts and API enforce roles independently. */
function RequireRole({ role, children }) {
  const w = useWallet();
  if (!w.account) return <p className="card">Connect your wallet to continue.</p>;
  if (!w.hasRole(role))
    return (
      <p className="card">
        This page needs the <b>{role}</b> role. {role === "client" && "Register as a Client on the Account page."}
      </p>
    );
  return children;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="escrows" element={<Escrows />} />
            <Route path="escrows/:id" element={<EscrowDetail />} />
            <Route
              path="new"
              element={
                <RequireRole role="client">
                  <CreateEscrow />
                </RequireRole>
              }
            />
            <Route path="disputes" element={<Disputes />} />
            <Route path="events" element={<Events />} />
            <Route path="account" element={<Account />} />
            <Route
              path="admin"
              element={
                <RequireRole role="admin">
                  <Admin />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  </StrictMode>
);
