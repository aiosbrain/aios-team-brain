"use client";

import { useRef, useState, useTransition } from "react";
import { Camera, Loader2 } from "lucide-react";
import { saveAvatar } from "@/app/t/[team]/people/[handle]/actions";
import { MemberAvatar, type MemberAvatarPerson } from "@/components/people/member-avatar";

const TARGET_PX = 256;
const JPEG_QUALITY = 0.85;

/**
 * Resize + compress an image file entirely client-side (no server-side image-processing
 * dependency — this codebase has no file/blob storage at all, so avatars are stored as small
 * data: URLs in Postgres; keeping them small starts here). Downscales to fit TARGET_PXxTARGET_PX,
 * center-cropped square, re-encoded as JPEG.
 */
async function resizeToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = TARGET_PX;
  canvas.height = TARGET_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas not supported");
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, TARGET_PX, TARGET_PX);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export function AvatarUpload({
  teamSlug,
  memberId,
  person,
}: {
  teamSlug: string;
  memberId: string;
  person: MemberAvatarPerson;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("please choose an image file");
      return;
    }
    setError(null);
    try {
      const dataUrl = await resizeToDataUrl(file);
      setPreview(dataUrl);
      startTransition(async () => {
        const res = await saveAvatar(teamSlug, memberId, dataUrl);
        if (!res.ok) {
          setError(res.error ?? "could not save photo");
          setPreview(null);
        }
      });
    } catch {
      setError("could not read that image");
    }
  }

  const displayed: MemberAvatarPerson = preview ? { ...person, avatarDataUrl: preview } : person;

  return (
    <div className="relative inline-block">
      <MemberAvatar person={displayed} size={56} />
      <button
        type="button"
        disabled={pending}
        onClick={() => inputRef.current?.click()}
        aria-label="Change profile picture"
        className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full border-2 border-surface-raised bg-violet text-white shadow-sm hover:opacity-90 disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-3 animate-spin" /> : <Camera className="size-3" />}
      </button>
      <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
      {error ? <p className="absolute top-full mt-1 w-40 text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
