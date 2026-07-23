"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { useJournal } from "@/lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

export default function JournalPage() {
  const token = useAuthStore((s) => s.accessToken);
  const { data: entries, isLoading } = useJournal();
  const qc = useQueryClient();
  const [setup, setSetup] = useState("");
  const [thesis, setThesis] = useState("");
  const [emotion, setEmotion] = useState("calm");
  const [lesson, setLesson] = useState("");
  const [rating, setRating] = useState("3");
  const [saving, setSaving] = useState(false);

  async function create() {
    setSaving(true);
    try {
      await api("/journal", {
        method: "POST",
        token: token!,
        body: JSON.stringify({
          setup,
          thesis,
          emotion,
          lesson,
          rating: Number(rating),
          status: "DRAFT",
        }),
      });
      toast.success("Journal entry saved");
      setSetup("");
      setThesis("");
      setLesson("");
      void qc.invalidateQueries({ queryKey: ["journal"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel title="New Entry">
        <div className="space-y-3">
          <Field label="Setup">
            <Input value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="Breakout retest" />
          </Field>
          <Field label="Thesis">
            <Textarea value={thesis} onChange={(e) => setThesis(e.target.value)} />
          </Field>
          <Field label="Emotion">
            <Input value={emotion} onChange={(e) => setEmotion(e.target.value)} />
          </Field>
          <Field label="Lesson">
            <Textarea value={lesson} onChange={(e) => setLesson(e.target.value)} />
          </Field>
          <Field label="Rating (1-5)">
            <Input
              type="number"
              min={1}
              max={5}
              value={rating}
              onChange={(e) => setRating(e.target.value)}
            />
          </Field>
          <Button variant="primary" className="w-full" loading={saving} onClick={() => void create()}>
            Save entry
          </Button>
        </div>
      </Panel>

      <Panel title="Journal" className="lg:col-span-2">
        {isLoading ? (
          <div className="py-8 text-center text-sm text-white/35">Loading…</div>
        ) : (
          <div className="space-y-3">
            {(entries ?? []).map((e) => (
              <div key={e.id} className="rounded-md border border-white/[0.06] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium text-white">{e.setup || "Untitled setup"}</div>
                  <div className="flex items-center gap-2">
                    {e.rating != null ? <Badge tone="accent">{e.rating}/5</Badge> : null}
                    <Badge>{e.status}</Badge>
                  </div>
                </div>
                {e.thesis ? <p className="mt-1 text-xs text-white/55">{e.thesis}</p> : null}
                {e.lesson ? <p className="mt-1 text-xs text-accent-soft">Lesson: {e.lesson}</p> : null}
                <div className="mt-2 text-[10px] text-white/30">
                  {new Date(e.createdAt).toLocaleString()}
                  {e.emotion ? ` · ${e.emotion}` : ""}
                </div>
              </div>
            ))}
            {(entries ?? []).length === 0 ? (
              <div className="py-8 text-center text-sm text-white/35">No journal entries</div>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
