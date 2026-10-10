import { formatEther, formatUnits } from "ethers";
import { txLink } from "../config";

/** Modal that shows gas estimate before signing and real gas used after mining. */
export default function TxDialog({ tx, onClose }) {
  const { label, phase, estimate, receipt, hash, error } = tx;
  const close = () => (tx.cancel && phase === "confirm" ? tx.cancel() : onClose());
  const link = hash && txLink(hash);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="tx-title">
      <div className="modal">
        <h3 id="tx-title">{label}</h3>

        {phase === "estimating" && <p className="muted">Estimating gas…</p>}

        {phase === "confirm" && (
          <>
            <dl className="kv">
              <dt>Estimated gas</dt>
              <dd className="num">{estimate.gas.toLocaleString()} units</dd>
              <dt>Max fee per gas</dt>
              <dd className="num">{Number(formatUnits(estimate.price, "gwei")).toFixed(3)} gwei</dd>
              <dt>Max network fee</dt>
              <dd className="num">{Number(formatEther(estimate.cost)).toFixed(6)} ETH</dd>
            </dl>
            <p className="muted small">
              Gas limit is set to estimate + 20%. You only pay for gas actually used, at the base fee + tip.
            </p>
            <div className="row end">
              <button className="btn ghost" onClick={tx.cancel}>
                Cancel
              </button>
              <button className="btn primary" onClick={tx.send} autoFocus>
                Confirm in wallet
              </button>
            </div>
          </>
        )}

        {phase === "pending" && (
          <p>
            {hash ? "Waiting for confirmation…" : "Confirm the transaction in MetaMask…"}
            {hash && <code className="block small">{hash}</code>}
          </p>
        )}

        {phase === "mined" && (
          <>
            <p className="ok">Confirmed in block {receipt.blockNumber}.</p>
            <dl className="kv">
              <dt>Gas used</dt>
              <dd className="num">
                {receipt.gasUsed.toLocaleString()}
                {estimate && ` (${((Number(receipt.gasUsed) / Number(estimate.gas)) * 100).toFixed(0)}% of estimate)`}
              </dd>
              <dt>Fee paid</dt>
              <dd className="num">{Number(formatEther(receipt.fee ?? 0n)).toFixed(6)} ETH</dd>
            </dl>
            {link && (
              <a href={link} target="_blank" rel="noreferrer">
                View on Etherscan
              </a>
            )}
            <div className="row end">
              <button className="btn primary" onClick={onClose} autoFocus>
                Done
              </button>
            </div>
          </>
        )}

        {phase === "error" && (
          <>
            <p className="err" role="alert">
              {error}
            </p>
            <div className="row end">
              <button className="btn" onClick={onClose} autoFocus>
                Close
              </button>
            </div>
          </>
        )}

        {phase !== "confirm" && phase !== "mined" && phase !== "error" && (
          <button className="modal-x" aria-label="Close" onClick={close}>
            ×
          </button>
        )}
      </div>
    </div>
  );
}
