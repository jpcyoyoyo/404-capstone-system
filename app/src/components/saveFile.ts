// Saving an exported file. In a browser it downloads. In the Android app a download link does
// nothing (the WebView has no download manager), so the file is written to the app's cache and
// handed to Android's share sheet: Save to Files or Drive, or send it in Messenger or Gmail.
import { Capacitor } from '@capacitor/core';

export type SaveResult = 'downloaded' | 'shared' | 'cancelled';

const isNative = () => { try { return Capacitor.isNativePlatform(); } catch { return false; } };

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

export async function saveFile(name: string, blob: Blob): Promise<SaveResult> {
  if (!isNative()) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'downloaded';
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const { uri } = await Filesystem.writeFile({ path: `exports/${name}`, data: await blobToBase64(blob), directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: name, files: [uri], dialogTitle: 'Save or send the export' });
    return 'shared';
  } catch (e) {
    if (/cancel/i.test(e instanceof Error ? e.message : String(e))) return 'cancelled';
    throw e;
  }
}

/** A CSV made in the app (demo mode, "this view"), with the byte-order mark Excel needs for UTF-8. */
export const csvBlob = (csv: string) => new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
