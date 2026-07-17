import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { CloseIcon, CopyIcon, CheckIcon } from './icons';

interface Props {
  address: string;
  networkName?: string;
  onClose: () => void;
}

export function ReceiveModal({ address, networkName, onClose }: Props) {
  const [qrSvg, setQrSvg] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!address) { setQrSvg(''); return; }
    QRCode.toString(address, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 0,
      color: { dark: '#1a1d26', light: '#ffffff00' },
    })
      .then(setQrSvg)
      .catch(() => setQrSvg(''));
  }, [address]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function onOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  return (
    <div ref={overlayRef} className="receive-modal-overlay" onClick={onOverlayClick}>
      <div className="receive-modal-panel" role="dialog" aria-modal="true" aria-label="Receive funds">
        <div className="receive-modal-header">
          <span className="receive-modal-title">Receive</span>
          <button onClick={onClose} className="receive-modal-close" aria-label="Close">
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="receive-modal-body">
          <div className="receive-modal-qr">
            {qrSvg
              ? <div dangerouslySetInnerHTML={{ __html: qrSvg }} />
              : <span className="receive-modal-generating">Generating…</span>}
          </div>

          {networkName && (
            <span className="receive-modal-network">{networkName}</span>
          )}

          <div className="receive-modal-address mono">{address}</div>
        </div>

        <div className="receive-modal-footer">
          <button onClick={copyAddress} className="btn-primary">
            <span className="btn-icon-text">
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              {copied ? 'Copied' : 'Copy address'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
