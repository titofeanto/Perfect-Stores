// Barcode scanning: pakai native BarcodeDetector API kalau tersedia (Chrome/Android --
// cepat, tanpa download tambahan, decode dilakukan hardware/OS). Kalau tidak tersedia
// (Safari/iPhone belum implementasi API ini per pertengahan 2026), fallback ke library
// html5-qrcode yang di-load dari CDN HANYA saat dibutuhkan (jadi user Android tidak pernah
// men-download library tambahan ini sama sekali).

const FALLBACK_LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
const BARCODE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

export function supportsNativeBarcodeDetector() {
  return 'BarcodeDetector' in window;
}

let nativeStream = null;
let nativeRafId = null;

export async function startNativeScan(videoEl, onResult, onError) {
  try {
    const detector = new BarcodeDetector({ formats: BARCODE_FORMATS });
    nativeStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    videoEl.srcObject = nativeStream;
    await videoEl.play();

    const loop = async () => {
      if (!nativeStream) return; // dihentikan dari luar
      try {
        const barcodes = await detector.detect(videoEl);
        if (barcodes.length) {
          onResult(barcodes[0].rawValue);
          return;
        }
      } catch (e) {
        // gagal decode di 1 frame itu wajar (blur, sudut kamera, dll), lanjut frame berikutnya
      }
      nativeRafId = requestAnimationFrame(loop);
    };
    nativeRafId = requestAnimationFrame(loop);
  } catch (err) {
    onError(err);
  }
}

export function stopNativeScan(videoEl) {
  if (nativeRafId) cancelAnimationFrame(nativeRafId);
  nativeRafId = null;
  if (nativeStream) {
    nativeStream.getTracks().forEach(t => t.stop());
    nativeStream = null;
  }
  if (videoEl) videoEl.srcObject = null;
}

let fallbackLibLoading = null;
function loadFallbackLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (fallbackLibLoading) return fallbackLibLoading;
  fallbackLibLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = FALLBACK_LIB_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Gagal memuat library scanner'));
    document.head.appendChild(script);
  });
  return fallbackLibLoading;
}

let fallbackInstance = null;

export async function startFallbackScan(containerId, onResult, onError) {
  try {
    await loadFallbackLib();
    fallbackInstance = new window.Html5Qrcode(containerId);
    await fallbackInstance.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 130 } },
      (decodedText) => onResult(decodedText),
      () => {} // gagal decode 1 frame, abaikan
    );
  } catch (err) {
    onError(err);
  }
}

export async function stopFallbackScan() {
  if (fallbackInstance) {
    try {
      await fallbackInstance.stop();
      fallbackInstance.clear();
    } catch (e) {
      // sudah berhenti / elemen sudah tidak ada, aman diabaikan
    }
    fallbackInstance = null;
  }
}
