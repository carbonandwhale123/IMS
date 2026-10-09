import { useState, useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  Ban,
  Camera,
  CheckCircle2,
  CircleDot,
  Copy,
  ExternalLink,
  Mail,
  Receipt,
  Rocket,
  WifiOff,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import AppShell from "@/components/layout/AppShell";
import EmptyState from "@/components/shared/EmptyState";
import FileUploader from "@/components/shared/FileUploader";
import DocumentList from "@/components/shared/DocumentList";
import AuditTrail from "@/components/shared/AuditTrail";
import SendClientEmailDialog from "@/components/shared/SendClientEmailDialog";
import { GtpStatusBadge, StageBadge } from "@/components/shared/StatusBadges";
import { Button, buttonVariants } from "@/components/ui/button";
import { CampaignDetailSkeleton } from "@/components/skeletons";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import PriorityBadge from "@/components/shared/PriorityBadge";
import PaymentMilestones from "@/components/campaigns/PaymentMilestones";
import { calculateRevenueSplit, computeMilestoneSchedule, REVENUE_SHARE_MATRIX, matchVenueRule } from "@/lib/revenueShare";
import { promoteNextWaitlistOrFreeAsset } from "@/lib/realtime";
import { supabase } from "@/lib/supabase";
import { queryClient } from "@/lib/queryClient";
import { useCampaign, useAsset, useMe } from "@/lib/queries";
import { enqueueOfflineGtp, cacheCampaignsOffline } from "@/lib/offlineStore";
import { notifyBrandAdStatusUpdate } from "@/lib/resend";
import { errMessage, fmtDate, fmtDateTime, fmtMoney, getAppBaseUrl } from "@/lib/helpers";
import { cn } from "@/lib/utils";


const STAGE_ORDER = ["onboarding", "invoicing", "live", "closing", "closed"];

function useRefresh(campaignId) {
  return () => {
    queryClient.invalidateQueries({ queryKey: ["campaign", campaignId] });
    queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    queryClient.invalidateQueries({ queryKey: ["assets"] });
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };
}

function LifecycleTracker({ stage }) {
  const idx = STAGE_ORDER.indexOf(stage);
  return (
    <ol className="flex flex-wrap items-center gap-2" data-testid="lifecycle-tracker">
      {STAGE_ORDER.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors duration-200",
              i < idx
                ? "border-emerald-200 bg-emerald-50 text-[#006d37] font-semibold"
                : i === idx
                  ? "border-sky-300 bg-sky-50 text-[#00668a] font-semibold"
                  : "border-border/80 bg-card text-muted-foreground",
            )}
            data-testid={`lifecycle-step-${s}`}
          >
            {i < idx ? <CheckCircle2 className="size-3" /> : <CircleDot className="size-3" />}
            {s}
          </span>
          {i < STAGE_ORDER.length - 1 && <span className="h-px w-3 bg-border/70" />}
        </li>
      ))}
    </ol>
  );
}

function PrioritySelect({ campaign, gtpId, value }) {
  const { data: me } = useMe();
  const refresh = useRefresh(campaign.id);
  const canEdit = me?.role === "ops" || me?.role === "admin";

  const save = useMutation({
    mutationFn: async (priority) => {
      if (gtpId) {
        // Bug #1 fix: Only update the gtps array — do NOT touch the campaign-level priority.
        const { data: c } = await supabase.from("campaigns").select("gtps").eq("id", campaign.id).single();
        const gtps = (c?.gtps ?? []).map((g) => g.id === gtpId ? { ...g, priority } : g);
        const { error } = await supabase.from("campaigns").update({ gtps }).eq("id", campaign.id);
        if (error) throw { body: { detail: error.message } };
        return { priority };
      }
      const { error } = await supabase.from("campaigns").update({ priority }).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      return { priority };
    },
    onSuccess: (_r, priority) => {
      refresh();
      toast.success(`Priority set to ${priority}`);
    },
    onError: (err) => toast.error(errMessage(err, "Could not change the priority")),
  });

  if (!canEdit) return <PriorityBadge priority={value} />;

  // Scope the option testids per select — several of these render on one page.
  const scope = gtpId ? `gtp-${gtpId}` : "campaign";

  return (
    <Select value={value} onValueChange={(v) => save.mutate(v)}>
      <SelectTrigger
        size="sm"
        className="h-7 w-28"
        data-testid={gtpId ? `gtp-priority-select-${gtpId}` : "campaign-priority-select"}
      >
        <SelectValue placeholder="medium" />
      </SelectTrigger>
      <SelectContent>
        {["high", "medium", "low"].map((p) => (
          <SelectItem key={p} value={p} data-testid={`priority-option-${scope}-${p}`}>
            {p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChecklistItem({ campaign, item }) {
  const { data: me } = useMe();
  const refresh = useRefresh(campaign.id);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [docs, setDocs] = useState([]);
  const canEdit = (me?.role === "ops" || me?.role === "admin") && campaign.stage === "onboarding";

  const save = useMutation({
    mutationFn: async (body) => {
      const hasOfflineDocs = docs.some((d) => d.isOffline);
      if (!navigator.onLine || hasOfflineDocs) {
        await enqueueOfflineGtp({
          campaignId: campaign.id,
          campaignName: campaign.brand,
          assetCode: campaign.asset_code,
          checklistKey: item.key,
          checklistItemLabel: item.label,
          notes: body.notes,
          files: docs,
          userProfile: me,
        });
        return { isOfflineQueued: true };
      }

      const { data: c } = await supabase.from("campaigns").select("checklist").eq("id", campaign.id).single();

      // Resolve the current user's name before .map() so we don't need await inside a sync callback
      let completedByName = null;
      if (body.status === "done") {
        const { data: { user } } = await supabase.auth.getUser();
        const { data: profile } = await supabase.from("profiles").select("name").eq("id", user?.id).single();
        completedByName = profile?.name ?? null;
      }

      const checklist = (c?.checklist ?? []).map((ci) =>
        ci.key === item.key
          ? {
              ...ci,
              status: body.status,
              notes: body.notes ?? ci.notes,
              doc_ids: body.doc_ids?.length ? body.doc_ids : ci.doc_ids,
              completed_by: body.status === "done" ? completedByName : ci.completed_by,
              completed_at: body.status === "done" ? new Date().toISOString() : ci.completed_at,
            }
          : ci,
      );
      const { error } = await supabase.from("campaigns").update({ checklist }).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      return { checklist };
    },
    onSuccess: (res) => {
      refresh();
      setDocs([]);
      if (res?.isOfflineQueued) {
        toast.success(`${item.label} saved to Offline Queue (will auto-sync when connected)`);
      } else {
        toast.success(`${item.label} updated`);
      }
    },
    onError: (err) => toast.error(errMessage(err, "Could not update the checklist")),
  });


  const done = item.status === "done";

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3.5 transition-colors duration-200",
        done ? "border-emerald-200 bg-emerald-50/60 shadow-xs" : "border-border/80 bg-card shadow-xs",
      )}
      data-testid={`checklist-item-${item.key}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-heading text-sm font-medium">{item.label}</p>
          <p className="mono-label mt-0.5 text-muted-foreground">
            {done ? `Done · ${item.completed_by} · ${fmtDateTime(item.completed_at)}` : item.status}
            {item.mandatory ? " · mandatory" : ""}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "mono-label",
            done ? "border-emerald-200 bg-emerald-50 text-[#006d37]" : "border-border/70 text-muted-foreground",
          )}
        >
          {item.status}
        </Badge>
      </div>

      {item.notes && <p className="mt-2 text-xs text-muted-foreground">{item.notes}</p>}
      {item.doc_ids?.length > 0 && (
        <div className="mt-2">
          <DocumentList docIds={item.doc_ids} />
        </div>
      )}

      {canEdit && !done && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes for this step"
            data-testid={`checklist-notes-${item.key}`}
          />
          <FileUploader
            value={docs}
            onChange={setDocs}
            multiple
            geotag={item.key === "gtp_upload"}
            label="Attach proof"
            testId={`checklist-upload-${item.key}`}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={save.isPending || docs.length === 0}
              onClick={() =>
                save.mutate({ status: "done", notes, doc_ids: docs.map((d) => d.id) })
              }
              data-testid={`checklist-complete-${item.key}`}
              title={docs.length === 0 ? "Upload at least one attachment to complete this step" : undefined}
            >
              <CheckCircle2 className="size-4" />
              Mark complete
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ status: "in_progress", notes, doc_ids: docs.map((d) => d.id) })
              }
              data-testid={`checklist-progress-${item.key}`}
            >
              Save progress
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            At least one attachment is required before a step can be completed.
          </p>
        </div>
      )}
    </div>
  );
}

function InvoiceDialog({ campaign }) {
  const [open, setOpen] = useState(false);
  const todayStr = new Date().toISOString().split("T")[0];
  const { data: asset } = useAsset(campaign.asset_id);

  // Auto-resolve venue from asset or campaign code
  const initialVenue = asset?.location_name || campaign.asset_code || "Secura Kannur";
  const matchedRule = matchVenueRule(initialVenue, asset?.location_type);

  const [form, setForm] = useState({
    invoice_number: "",
    venue_name: matchedRule?.venue_name || "",
    display_count: "",
    unit_price: "",
    untaxed_amount: "",
    gst_percent: 18,
    notes: "",
    start_date: todayStr,
    // Flexible Balance Milestone Terms
    advance_percent: 50,
    balance_term_type: "net_5_days",
    custom_balance_due_date: "",
  });

  const [docs, setDocs] = useState([]);
  const refresh = useRefresh(campaign.id);

  // Auto calculate untaxed amount when display_count or unit_price changes
  const handleUnitOrPriceChange = (count, price) => {
    const totalUntaxed = (Number(count) || 0) * (Number(price) || 0);
    setForm((f) => ({
      ...f,
      display_count: count,
      unit_price: price,
      untaxed_amount: totalUntaxed,
    }));
  };

  // Live calculation of revenue share & net profit
  const revenueSplit = calculateRevenueSplit({
    untaxedAmount: form.untaxed_amount,
    venueName: form.venue_name,
  });

  const untaxed = Number(form.untaxed_amount) || 0;
  const gstPct = Number(form.gst_percent) || 18;
  const gstAmount = Math.round((untaxed * gstPct) / 100);
  const grossTotal = untaxed + gstAmount;

  const submit = useMutation({
    mutationFn: async (body) => {
      // Invoice: add invoice object, move to live, set start/end dates, generate GTP schedule
      const { data: settingsArr } = await supabase.from("settings").select("*").eq("id", "global").maybeSingle();
      const interval = settingsArr?.gtp_interval_days ?? 28;
      const startDate = body.start_date;
      const endDate = new Date(new Date(startDate).getTime() + campaign.duration_days * 86400000).toISOString().split("T")[0];

      // Generate GTP schedule
      const gtps = [];
      let dueDateMs = new Date(startDate).getTime() + interval * 86400000;
      let seq = 1;
      while (dueDateMs < new Date(endDate).getTime()) {
        gtps.push({ id: crypto.randomUUID(), seq, status: "pending", due_date: new Date(dueDateMs).toISOString().split("T")[0], is_final: false, doc_ids: [], priority: "medium" });
        dueDateMs += interval * 86400000;
        seq++;
      }
      gtps.push({ id: crypto.randomUUID(), seq, status: "pending", due_date: endDate, is_final: true, doc_ids: [], priority: "medium" });

      // Compute flexible 2-stage milestone schedule
      const milestones = computeMilestoneSchedule({
        totalAmount: grossTotal,
        advancePercent: body.advance_percent,
        balanceTermType: body.balance_term_type,
        customBalanceDueDate: body.custom_balance_due_date,
        campaignStartDate: startDate,
      });

      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();

      const invoice = {
        invoice_number: body.invoice_number,
        venue_name: body.venue_name,
        display_count: Number(body.display_count) || 1,
        unit_price: Number(body.unit_price) || 0,
        untaxed_amount: untaxed,
        amount: untaxed, // backwards compat
        gst_percent: gstPct,
        gst_amount: gstAmount,
        total_amount: grossTotal,
        party_share_percent: revenueSplit.party_share_pct,
        party_share_amount: revenueSplit.party_share_amount,
        cw_share_percent: revenueSplit.cw_share_pct,
        net_revenue: revenueSplit.net_revenue,
        milestones,
        notes: body.notes,
        doc_ids: body.doc_ids,
        invoice_date: startDate,
        raised_by: profile?.name ?? "",
        raised_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("campaigns").update({ stage: "live", invoice, gtps, start_date: startDate, end_date: endDate }).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      await supabase.from("assets").update({ status: "live", current_brand: campaign.brand }).eq("id", campaign.asset_id);
      return { ok: true };
    },
    onSuccess: () => {
      refresh();
      // notifyBrandAdStatusUpdate(campaign.id, "live");
      toast.success("Invoice & Milestones recorded — campaign is now live!");
      setOpen(false);
    },
    onError: (err) => toast.error(errMessage(err, "Could not raise the invoice")),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" data-testid="raise-invoice-button" />}>
        <Receipt className="size-4" />
        Raise GST invoice &amp; Schedule
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-heading">
            Odoo Invoice &amp; Payment Schedule · {campaign.brand}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate({
              invoice_number: form.invoice_number,
              venue_name: form.venue_name,
              display_count: form.display_count,
              unit_price: form.unit_price,
              untaxed_amount: form.untaxed_amount,
              gst_percent: form.gst_percent,
              notes: form.notes,
              doc_ids: docs.map((d) => d.id),
              start_date: form.start_date,
              advance_percent: form.advance_percent,
              balance_term_type: form.balance_term_type,
              custom_balance_due_date: form.custom_balance_due_date,
            });
          }}
          data-testid="invoice-form"
        >
          {/* Header invoice metadata */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="space-y-1">
              <Label htmlFor="invoice_number" className="text-xs">Invoice Number (Odoo)</Label>
              <Input
                id="invoice_number"
                required
                value={form.invoice_number}
                onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
                placeholder="e.g. CW137"
                className="h-8 text-xs font-mono uppercase"
                data-testid="invoice-number-input"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="start_date" className="text-xs">Invoice &amp; Start Date</Label>
              <Input
                id="start_date"
                type="date"
                required
                value={form.start_date}
                onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                className="h-8 text-xs"
                data-testid="invoice-start-date-input"
              />
            </div>
          </div>

          {/* Venue & Displays Breakdown (Odoo Format) */}
          <div className="rounded-lg border border-border/80 bg-secondary/20 p-3 space-y-2.5">
            <div className="space-y-1">
              <Label className="text-xs font-semibold text-foreground">Venue Location</Label>
              <Select
                value={form.venue_name}
                onValueChange={(v) => setForm((f) => ({ ...f, venue_name: v }))}
              >
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVENUE_SHARE_MATRIX.map((m) => (
                    <SelectItem key={m.venue_name} value={m.venue_name} className="text-xs">
                      {m.venue_name} ({m.share_type === "fixed_monthly" ? `Fixed ₹${m.fixed_monthly_fee.toLocaleString()}` : `${m.party_share_pct}% Revenue Share`})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1">
                <Label htmlFor="display_count" className="text-[11px]">Display Count</Label>
                <Input
                  id="display_count"
                  type="number"
                  min="1"
                  value={form.display_count}
                  onChange={(e) => handleUnitOrPriceChange(e.target.value, form.unit_price)}
                  className="h-7 text-xs font-mono"
                  placeholder="5"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="unit_price" className="text-[11px]">Rate / Unit (₹)</Label>
                <Input
                  id="unit_price"
                  type="number"
                  min="0"
                  value={form.unit_price}
                  onChange={(e) => handleUnitOrPriceChange(form.display_count, e.target.value)}
                  className="h-7 text-xs font-mono"
                  placeholder="5000"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="untaxed_amount" className="text-[11px]">Turnover (₹)</Label>
                <Input
                  id="untaxed_amount"
                  type="number"
                  min="1"
                  value={form.untaxed_amount}
                  onChange={(e) => setForm((f) => ({ ...f, untaxed_amount: Number(e.target.value) }))}
                  className="h-7 text-xs font-mono font-bold text-foreground"
                  data-testid="invoice-amount-input"
                />
              </div>
            </div>

            {/* Inbuilt Revenue Share Calculation Preview */}
            <div className="rounded-md border border-primary/20 bg-primary/5 p-2 flex items-center justify-between text-[11px]">
              <div>
                <span className="font-semibold text-primary">
                  {form.venue_name}: {revenueSplit.party_share_pct}% Share
                </span>
                <p className="text-muted-foreground text-[10px]">
                  Venue Payout: {fmtMoney(revenueSplit.party_share_amount)}
                </p>
              </div>
              <div className="text-right">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  Net C&amp;W Profit: {fmtMoney(revenueSplit.net_revenue)}
                </span>
                <p className="text-muted-foreground text-[10px] font-mono">
                  Gross: {fmtMoney(grossTotal)} (incl. 18% GST)
                </p>
              </div>
            </div>
          </div>

          {/* Flexible Milestone Payment Scheduler */}
          <div className="rounded-lg border border-border/80 bg-secondary/30 p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-foreground">Flexible Payment Milestones</Label>
              <Badge variant="outline" className="text-[10px] py-0 font-mono">
                2-Stage Milestone
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="space-y-1">
                <Label className="text-[11px]">Milestone 1: Advance %</Label>
                <Select
                  value={String(form.advance_percent)}
                  onValueChange={(v) => setForm((f) => ({ ...f, advance_percent: Number(v) }))}
                >
                  <SelectTrigger className="h-7 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="50">50% Advance ({fmtMoney(Math.round(grossTotal * 0.5))})</SelectItem>
                    <SelectItem value="40">40% Advance ({fmtMoney(Math.round(grossTotal * 0.4))})</SelectItem>
                    <SelectItem value="100">100% Full Upfront ({fmtMoney(grossTotal)})</SelectItem>
                    <SelectItem value="0">0% (100% on Balance/PO)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-[11px]">Milestone 2: Balance Term</Label>
                <Select
                  value={form.balance_term_type}
                  onValueChange={(v) => setForm((f) => ({ ...f, balance_term_type: v }))}
                >
                  <SelectTrigger className="h-7 text-xs bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="on_onboarding">Day of Onboarding (0 Days)</SelectItem>
                    <SelectItem value="net_5_days">After 5 Days (Post-GTP)</SelectItem>
                    <SelectItem value="net_15_days">Net 15 Days</SelectItem>
                    <SelectItem value="net_30_days">Net 30 Days</SelectItem>
                    <SelectItem value="custom_po">Custom PO Due Date</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {form.balance_term_type === "custom_po" && (
              <div className="space-y-1 pt-1 animate-in fade-in">
                <Label className="text-[11px]">PO Specified Balance Due Date</Label>
                <Input
                  type="date"
                  value={form.custom_balance_due_date}
                  onChange={(e) => setForm((f) => ({ ...f, custom_balance_due_date: e.target.value }))}
                  className="h-7 text-xs bg-background"
                />
              </div>
            )}
          </div>

          <FileUploader value={docs} onChange={setDocs} label="Attach Odoo Invoice PDF" testId="invoice-uploader" />

          <div className="space-y-1">
            <Label htmlFor="invoice-notes" className="text-xs">Notes (optional)</Label>
            <Textarea
              id="invoice-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="e.g. PO reference #PO-2026-9918, 5 displays booked"
              className="text-xs"
              data-testid="invoice-notes-input"
            />
          </div>

          <DialogFooter className="pt-1">
            <Button type="submit" disabled={submit.isPending} data-testid="submit-invoice-button" className="w-full sm:w-auto">
              {submit.isPending ? "Recording…" : "Confirm Invoice & Schedule Payments"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GtpCard({ campaign, gtp }) {
  const { data: me } = useMe();
  const refresh = useRefresh(campaign.id);
  const [docs, setDocs] = useState([]);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");

  const isOps = me?.role === "ops" || me?.role === "admin";
  const isFinance = ["finance", "finance_manager", "admin"].includes(me?.role);

  const submit = useMutation({
    mutationFn: async (body) => {
      const hasOfflineDocs = docs.some((d) => d.isOffline);
      if (!navigator.onLine || hasOfflineDocs) {
        await enqueueOfflineGtp({
          campaignId: campaign.id,
          campaignName: campaign.brand,
          assetCode: campaign.asset_code,
          gtpId: gtp.id,
          gtpSeq: gtp.seq,
          notes: body.notes,
          files: docs,
          userProfile: me,
        });
        return { isOfflineQueued: true };
      }

      const { data: c } = await supabase.from("campaigns").select("gtps").eq("id", campaign.id).single();
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();
      const gtps = (c?.gtps ?? []).map((g) =>
        g.id === gtp.id
          ? { ...g, status: "submitted", doc_ids: body.doc_ids ?? g.doc_ids, notes: body.notes ?? g.notes, submitted_by: profile?.name, submitted_at: new Date().toISOString() }
          : g,
      );
      const { error } = await supabase.from("campaigns").update({ gtps }).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      return { ok: true };
    },
    onSuccess: (res) => {
      refresh();
      setDocs([]);
      if (res?.isOfflineQueued) {
        toast.success(`GTP #${gtp.seq} saved to Offline Queue (will auto-sync when connected)`);
      } else {
        toast.success(`GTP #${gtp.seq} submitted for approval`);
      }
    },
    onError: (err) => toast.error(errMessage(err, "Could not submit the GTP")),
  });


  const review = useMutation({
    mutationFn: async (body) => {
      const { data: c } = await supabase.from("campaigns").select("gtps,stage,cancellation,asset_id,asset_code,brand").eq("id", campaign.id).single();
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();
      const gtps = (c?.gtps ?? []).map((g) =>
        g.id === gtp.id
          ? { ...g, status: body.approve ? "approved" : "rejected", reject_reason: body.reason ?? null, reviewed_by: profile?.name, reviewed_at: new Date().toISOString() }
          : g,
      );
      
      const allApproved = gtps.every((g) => g.status === "approved");
      const isClosureGtp = gtp.is_final || gtp.seq === 99;
      let assetFreed = false;

      // If Finance approves closure GTP (or all GTPs for a closing campaign), automatically complete closure and release the asset!
      if (body.approve && (isClosureGtp || (c.stage === "closing" && allApproved))) {
        const todayStr = new Date().toISOString().split("T")[0];
        const updates = {
          gtps,
          stage: "closed",
          end_date: c.end_date || todayStr,
        };
        if (c.cancellation?.status === "approved") {
          updates.cancellation = {
            ...c.cancellation,
            status: "completed",
            completed_at: new Date().toISOString(),
          };
        }
        const { error } = await supabase.from("campaigns").update(updates).eq("id", campaign.id);
        if (error) throw { body: { detail: error.message } };

        // Audit log
        await supabase.from("audit_logs").insert({
          id: crypto.randomUUID(),
          entity_type: "campaign",
          entity_id: campaign.id,
          action: "campaign_closed_asset_freed",
          actor_name: profile?.name || "System",
          comment: `Closure GTP #${gtp.seq} approved. Campaign for ${c.brand || campaign.brand} closed and asset ${c.asset_code || campaign.asset_code} freed.`,
          created_at: new Date().toISOString(),
        });

        // Release asset and auto-promote waitlist
        await promoteNextWaitlistOrFreeAsset(c.asset_id || campaign.asset_id, c.asset_code || campaign.asset_code);
        // notifyBrandAdStatusUpdate(campaign.id, "closed");
        assetFreed = true;
      } else {
        const finalApproved = body.approve && gtp.is_final;
        const newStage = finalApproved || allApproved ? "closing" : c.stage;
        const { error } = await supabase.from("campaigns").update({ gtps, stage: newStage }).eq("id", campaign.id);
        if (error) throw { body: { detail: error.message } };
      }

      return { approve: body.approve, assetFreed };
    },
    onSuccess: (_res, vars) => {
      refresh();
      if (_res?.assetFreed) {
        toast.success(`Closure GTP #${gtp.seq} approved — Campaign closed & Asset freed!`);
      } else {
        toast.success(vars.approve ? `GTP #${gtp.seq} approved` : `GTP #${gtp.seq} returned to Ops`);
      }
    },
    onError: (err) => toast.error(errMessage(err, "Could not review the GTP")),
  });

  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3.5",
        gtp.status === "approved"
          ? "border-emerald-200 bg-emerald-50/60 shadow-xs"
          : gtp.status === "rejected"
            ? "border-red-200 bg-red-50/60 shadow-xs"
            : "border-border/80 bg-card shadow-xs",
      )}
      data-testid={`gtp-card-${gtp.seq}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-heading text-sm font-medium">
            GTP #{gtp.seq}
            {gtp.is_final && <span className="ml-1.5 text-xs text-muted-foreground">(final)</span>}
          </p>
          <p className="mono-label mt-0.5 text-muted-foreground">Due {fmtDate(gtp.due_date)}</p>
        </div>
        <div className="flex items-center gap-2">
          <GtpStatusBadge status={gtp.status} />
          {gtp.status !== "approved" ? (
            <PrioritySelect campaign={campaign} gtpId={gtp.id} value={gtp.priority ?? "medium"} />
          ) : (
            <PriorityBadge priority={gtp.priority ?? "medium"} />
          )}
        </div>
      </div>

      {gtp.notes && <p className="mt-2 text-xs text-muted-foreground">{gtp.notes}</p>}
      {gtp.submitted_by && (
        <p className="mono-label mt-1 text-muted-foreground">
          Submitted by {gtp.submitted_by} · {fmtDateTime(gtp.submitted_at)}
        </p>
      )}
      {gtp.reviewed_by && (
        <p className="mono-label mt-0.5 text-muted-foreground">
          Reviewed by {gtp.reviewed_by} · {fmtDateTime(gtp.reviewed_at)}
        </p>
      )}
      {gtp.reject_reason && (
        <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-[#ba1a1a] shadow-xs">
          Rejected: {gtp.reject_reason}
        </p>
      )}
      {gtp.doc_ids?.length > 0 && (
        <div className="mt-2">
          <DocumentList docIds={gtp.doc_ids} />
        </div>
      )}

      {isOps && ["pending", "rejected"].includes(gtp.status) && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
          <FileUploader
            value={docs}
            onChange={setDocs}
            multiple
            geotag
            label="Capture geo-tagged photos"
            testId={`gtp-uploader-${gtp.seq}`}
          />
          <Textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Site notes (optional)"
            data-testid={`gtp-notes-${gtp.seq}`}
          />
          <Button
            size="sm"
            disabled={submit.isPending || !docs.length}
            onClick={() => submit.mutate({ doc_ids: docs.map((d) => d.id), notes })}
            data-testid={`gtp-submit-${gtp.seq}`}
          >
            <Camera className="size-4" />
            {submit.isPending ? "Submitting…" : "Submit GTP"}
          </Button>
        </div>
      )}

      {isFinance && gtp.status === "submitted" && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
          <Textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Rejection reason (required to reject)"
            data-testid={`gtp-reason-${gtp.seq}`}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={review.isPending}
              onClick={() => review.mutate({ approve: true, reason: "" })}
              data-testid={`gtp-approve-${gtp.seq}`}
            >
              <CheckCircle2 className="size-4" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={review.isPending}
              onClick={() => {
                if (!reason.trim()) {
                  toast.error("A rejection reason is required");
                  return;
                }
                review.mutate({ approve: false, reason });
              }}
              data-testid={`gtp-reject-${gtp.seq}`}
            >
              <XCircle className="size-4" />
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CancellationPanel({ campaign }) {
  const { data: me } = useMe();
  const refresh = useRefresh(campaign.id);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ reason: "", proposed_cancel_date: "" });
  const [docs, setDocs] = useState([]);
  const [comment, setComment] = useState("");

  const canRequest =
    me?.role === "sales" &&
    ["onboarding", "invoicing", "live"].includes(campaign.stage) &&
    campaign.cancellation?.status !== "requested";
  const canReview =
    ["finance", "finance_manager", "admin"].includes(me?.role) &&
    campaign.cancellation?.status === "requested";

  const request = useMutation({
    mutationFn: async (body) => {
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();
      const cancellation = {
        status: "requested",
        reason: body.reason,
        proposed_cancel_date: body.proposed_cancel_date,
        doc_ids: body.doc_ids ?? [],
        requested_by_name: profile?.name ?? "",
        requested_at: new Date().toISOString(),
      };
      const { error } = await supabase.from("campaigns").update({ cancellation }).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      return { ok: true };
    },
    onSuccess: () => {
      refresh();
      toast.success("Cancellation request sent to Finance");
      setOpen(false);
    },
    onError: (err) => toast.error(errMessage(err, "Could not request cancellation")),
  });

  const review = useMutation({
    mutationFn: async (body) => {
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();
      const { data: c } = await supabase.from("campaigns").select("cancellation,start_date,asset_id").eq("id", campaign.id).single();
      const cancellation = { ...(c?.cancellation ?? {}), status: body.approve ? "approved" : "rejected", comment: body.comment, reviewed_by: profile?.name, reviewed_at: new Date().toISOString() };
      const updates = { cancellation };
      if (body.approve) {
        updates.stage = "closing";
        const cancelDate = cancellation.proposed_cancel_date || new Date().toISOString().split("T")[0];
        updates.end_date = cancelDate;

        // Recalculate duration days if start date exists
        if (c?.start_date && cancellation.proposed_cancel_date) {
          const diffDays = Math.max(1, Math.round((new Date(cancellation.proposed_cancel_date) - new Date(c.start_date)) / 86400000));
          updates.duration_days = diffDays;
        }

        // Create high-priority closure GTP for Operations
        const closureGtp = {
          id: crypto.randomUUID(),
          seq: 99,
          status: "pending",
          due_date: cancelDate,
          is_final: true,
          doc_ids: [],
          priority: "high",
          notes: "Premature Cancellation: Offboarding & dismantling field inspection",
        };
        const { data: existing } = await supabase.from("campaigns").select("gtps").eq("id", campaign.id).single();
        updates.gtps = [...(existing?.gtps ?? []), closureGtp];

        // Mark the asset status as closing
        if (campaign.asset_id || c?.asset_id) {
          await supabase.from("assets").update({ status: "closing" }).eq("id", campaign.asset_id || c.asset_id);
        }
      }
      const { error } = await supabase.from("campaigns").update(updates).eq("id", campaign.id);
      if (error) throw { body: { detail: error.message } };
      return { approve: body.approve };
    },
    onSuccess: (_r, vars) => {
      refresh();
      if (vars.approve) {
        // notifyBrandAdStatusUpdate(campaign.id, "closing");
      }
      toast.success(vars.approve ? "Cancellation approved — duration shortened & closure GTP created" : "Cancellation rejected");
    },
    onError: (err) => toast.error(errMessage(err, "Could not review the request")),
  });

  const c = campaign.cancellation;

  return (
    <div className="space-y-3">
      {c ? (
        <div
          className={cn(
            "rounded-xl border px-4 py-3.5",
            c.status === "approved"
              ? "border-orange-200 bg-orange-50 shadow-xs"
              : c.status === "rejected"
                ? "border-border/80 bg-card shadow-xs"
                : "border-amber-200 bg-amber-50 shadow-xs",
          )}
          data-testid="cancellation-record"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-heading text-sm font-medium">Premature cancellation</p>
            <Badge variant="outline" className="mono-label border-border/70" data-testid={`cancellation-status-${c.status}`}>
              {c.status}
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{c.reason}</p>
          <p className="mono-label mt-1.5 text-muted-foreground">
            Requested by {c.requested_by_name} · proposed cancel date {fmtDate(c.proposed_cancel_date)}
          </p>
          {c.reviewed_by && (
            <p className="mono-label mt-0.5 text-muted-foreground">
              Reviewed by {c.reviewed_by} · {fmtDateTime(c.reviewed_at)}
            </p>
          )}
          {c.comment && <p className="mt-1.5 text-xs text-foreground">{c.comment}</p>}
          {c.doc_ids?.length > 0 && (
            <div className="mt-2">
              <DocumentList docIds={c.doc_ids} />
            </div>
          )}

          {canReview && (
            <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
              <Textarea
                rows={2}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Decision comment"
                data-testid="cancellation-comment-input"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={review.isPending}
                  onClick={() => review.mutate({ approve: true, comment })}
                  data-testid="approve-cancellation-button"
                >
                  Approve cancellation
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={review.isPending}
                  onClick={() => review.mutate({ approve: false, comment })}
                  data-testid="reject-cancellation-button"
                >
                  Reject
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          title="No cancellation request"
          hint="Sales can request a premature cancellation with a reason, a proposed date and optional documents."
          testId="cancellation-empty"
        />
      )}

      {canRequest && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button variant="outline" size="sm" data-testid="request-cancellation-button" />}>
            <Ban className="size-4" />
            Request cancellation
          </DialogTrigger>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="font-heading">Premature cancellation</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                request.mutate({ ...form, doc_ids: docs.map((d) => d.id) });
              }}
              data-testid="cancellation-form"
            >
              <div className="space-y-1.5">
                <Label htmlFor="cancel-reason">Reason</Label>
                <Textarea
                  id="cancel-reason"
                  rows={3}
                  required
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  data-testid="cancellation-reason-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cancel-date">Proposed cancel date</Label>
                <Input
                  id="cancel-date"
                  type="date"
                  required
                  value={form.proposed_cancel_date}
                  onChange={(e) => setForm((f) => ({ ...f, proposed_cancel_date: e.target.value }))}
                  data-testid="cancellation-date-input"
                />
              </div>
              <FileUploader value={docs} onChange={setDocs} multiple label="Attach supporting docs" testId="cancellation-uploader" />
              <DialogFooter>
                <Button type="submit" disabled={request.isPending} data-testid="submit-cancellation-button">
                  {request.isPending ? "Sending…" : "Send to Finance"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export default function CampaignDetail() {
  const { campaignId } = useParams();
  const { data: me } = useMe();
  const { data: campaign, isError, isLoading } = useCampaign(campaignId);
  const refresh = useRefresh(campaignId);

  const onboard = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("campaigns").update({ stage: "invoicing" }).eq("id", campaignId);
      if (error) throw { body: { detail: error.message } };
      return { ok: true };
    },
    onSuccess: () => {
      refresh();
      // notifyBrandAdStatusUpdate(campaignId, "invoicing");
      toast.success("Ad onboarded — invoice request raised with Finance");
    },
    onError: (err) => toast.error(errMessage(err, "Could not mark as onboarded")),
  });

  const closeCampaign = useMutation({
    mutationFn: async () => {
      const todayStr = new Date().toISOString().split("T")[0];
      const { data: profile } = await supabase.from("profiles").select("name").eq("id", (await supabase.auth.getUser()).data.user?.id).single();

      const updates = {
        stage: "closed",
        end_date: campaign.end_date || todayStr,
      };

      if (campaign.cancellation) {
        updates.cancellation = {
          ...campaign.cancellation,
          status: "completed",
          completed_at: new Date().toISOString(),
        };
      }

      const { error } = await supabase.from("campaigns").update(updates).eq("id", campaignId);
      if (error) throw { body: { detail: error.message } };

      // Record audit log
      await supabase.from("audit_logs").insert({
        id: crypto.randomUUID(),
        entity_type: "campaign",
        entity_id: campaign.id,
        action: "campaign_closed_asset_freed",
        actor_name: profile?.name || "System",
        comment: `Campaign for ${campaign.brand} (${campaign.asset_code}) closed and offboarded. Asset is now freed.`,
        created_at: new Date().toISOString(),
      });

      // Free asset and auto-promote waitlist
      await promoteNextWaitlistOrFreeAsset(campaign.asset_id, campaign.asset_code);

      // Notify brand ad status
      // notifyBrandAdStatusUpdate(campaign.id, "closed");

      return { ok: true };
    },
    onSuccess: () => {
      refresh();
      toast.success(`Campaign closed! Asset ${campaign.asset_code} has been freed.`);
    },
    onError: (err) => toast.error(errMessage(err, "Could not finalize campaign closure")),
  });

  const isOps = me?.role === "ops" || me?.role === "admin";
  const isFinance = ["finance", "finance_manager", "admin"].includes(me?.role);
  const [tab, setTab] = useState("checklist");

  useEffect(() => {
    if (campaign?.id) {
      cacheCampaignsOffline([campaign]);
    }
  }, [campaign]);


  return (
    <AppShell
      title={campaign ? `${campaign.brand}` : "Campaign"}
      subtitle={campaign ? `${campaign.asset_code} · ${campaign.duration_days} day campaign` : "Loading…"}
      backTo="/campaigns"
      backLabel="Campaigns"
      backTestId="back-to-campaigns"
      actions={
        <div className="flex items-center gap-1.5 shrink-0">
          {campaign && (
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5 text-primary border-primary/40 hover:bg-primary/10 cursor-pointer shrink-0"
              onClick={() => {
                const url = `${getAppBaseUrl()}/view/${campaign.id}`;
                navigator.clipboard.writeText(url);
                toast.success("Client Proof-of-Performance link copied to clipboard!");
              }}
              data-testid="copy-client-pop-portal-button"
            >
              <Copy className="size-3.5" />
              <span>Copy Client Link</span>
            </Button>
          )}
          {campaign && (
            <Link
              to={`/view/${campaign.id}`}
              className={cn(buttonVariants({ variant: "outline", size: "xs" }), "gap-1.5 cursor-pointer shrink-0")}
              data-testid="view-client-pop-portal-button"
            >
              <ExternalLink className="size-3.5" />
              <span>View Portal</span>
            </Link>
          )}
          {campaign && <SendClientEmailDialog campaign={campaign} />}
        </div>
      }
    >
      {isError && (
        <EmptyState title="Campaign unavailable" hint="This campaign could not be loaded." testId="campaign-detail-error" />
      )}
      {isLoading && <CampaignDetailSkeleton />}

      {campaign && (
        <div className="space-y-5">
          <Card className="border-border/70 bg-card/80">
            <CardContent className="space-y-4 px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/assets/${campaign.asset_id}`}
                      className="mono-label text-primary hover:text-sky-300"
                      data-testid="campaign-asset-link"
                    >
                      {campaign.asset_code}
                    </Link>
                    <StageBadge stage={campaign.stage} />
                    <PriorityBadge priority={campaign.priority} />
                  </div>
                  <h2 className="mt-1 font-heading text-2xl font-bold tracking-tight" data-testid="campaign-brand">
                    {campaign.brand}
                  </h2>
                  {campaign.brand_id && (
                    <Link
                      to={`/brands/${campaign.brand_id}`}
                      className="mono-label text-muted-foreground transition-colors duration-150 hover:text-primary"
                      data-testid="campaign-brand-link"
                    >
                      View brand record →
                    </Link>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="mono-label text-muted-foreground">Task priority</span>
                    <PrioritySelect campaign={campaign} value={campaign.priority ?? "high"} />
                  </div>
                  {isOps && campaign.stage === "onboarding" && (
                    <Button
                      size="sm"
                      disabled={onboard.isPending || !campaign.checklist_complete}
                      onClick={() => onboard.mutate()}
                      data-testid="mark-onboarded-button"
                    >
                      <Rocket className="size-4" />
                      {campaign.checklist_complete
                        ? "Mark ad onboarded"
                        : `Checklist ${campaign.checklist_done}/${campaign.checklist_total}`}
                    </Button>
                  )}
                  {isFinance && campaign.stage === "invoicing" && <InvoiceDialog campaign={campaign} />}
                </div>
              </div>

              <LifecycleTracker stage={campaign.stage} />

              <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                {[
                  ["Salesperson", campaign.salesperson_name || "—"],
                  ["Final duration", `${campaign.duration_days} days`],
                  ["Sales proposed", `${campaign.proposed_duration_days} days`],
                  [
                    "Window",
                    campaign.start_date ? `${fmtDate(campaign.start_date)} → ${fmtDate(campaign.end_date)}` : "Not started",
                  ],
                ].map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="mono-label text-muted-foreground">{k}</dt>
                    <dd className="mt-0.5 truncate">{v}</dd>
                  </div>
                ))}
              </dl>

              {campaign.invoice && (
                <div className="rounded-xl border border-border/60 bg-secondary/30 px-4 py-3" data-testid="invoice-summary">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="mono-label text-muted-foreground">GST invoice</p>
                      <p className="mt-0.5 text-sm font-semibold text-foreground">
                        {campaign.invoice.invoice_number} · {fmtMoney(campaign.invoice.total_amount)} (incl.{" "}
                        {campaign.invoice.gst_percent}% GST) · raised by {campaign.invoice.raised_by}
                      </p>
                    </div>
                    {campaign.invoice.venue_name && (
                      <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                        {campaign.invoice.venue_name} ({campaign.invoice.display_count || 1} displays)
                      </Badge>
                    )}
                  </div>
                  {campaign.invoice.doc_ids?.length > 0 && (
                    <div className="mt-2">
                      <DocumentList docIds={campaign.invoice.doc_ids} />
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 2-Stage Payment Milestone Tracker & Revenue Sharing Widget */}
          <PaymentMilestones campaign={campaign} me={me} />

          {/* Campaign Closure & Asset Release Banner */}
          {campaign.stage === "closing" && (
            <div className="rounded-xl border border-orange-300 bg-orange-50/90 dark:bg-orange-950/40 p-4 shadow-xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="flex size-2 rounded-full bg-orange-500 animate-pulse" />
                    <p className="font-heading text-sm font-semibold text-orange-950 dark:text-orange-100">
                      Campaign in Closure &amp; Offboarding Phase
                    </p>
                    <Badge variant="outline" className="text-[10px] border-orange-300 text-orange-800 dark:text-orange-300">
                      Discharge Pending
                    </Badge>
                  </div>
                  <p className="text-xs text-orange-900/80 dark:text-orange-200/80">
                    {campaign.cancellation?.reason
                      ? `Cancellation: ${campaign.cancellation.reason} · Scheduled offboarding date: ${fmtDate(campaign.end_date)}`
                      : `Flight concluding on ${fmtDate(campaign.end_date)}. Final GTP inspection required before releasing asset.`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {(isFinance || isOps) && (
                    <Button
                      size="sm"
                      variant="default"
                      className="bg-orange-600 hover:bg-orange-700 text-white font-medium text-xs shadow-xs gap-1.5 cursor-pointer"
                      disabled={closeCampaign.isPending}
                      onClick={() => closeCampaign.mutate()}
                      data-testid="complete-closure-button"
                    >
                      <CheckCircle2 className="size-3.5" />
                      Complete Closure &amp; Free Asset
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {campaign.stage === "closed" && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 dark:bg-emerald-950/30 p-3.5 flex items-center justify-between text-xs text-emerald-950 dark:text-emerald-100 shadow-xs">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div>
                  <span className="font-semibold">Campaign Concluded &amp; Closed</span>
                  <p className="text-[11px] text-emerald-800/80 dark:text-emerald-300/80 mt-0.5">
                    Offboarded on {fmtDate(campaign.end_date || new Date().toISOString())}. Asset {campaign.asset_code} is freed and available.
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="border-emerald-300 text-emerald-800 dark:text-emerald-300 text-[10px]">
                Asset Available
              </Badge>
            </div>
          )}

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList variant="line" data-testid="campaign-tabs">
              <TabsTrigger value="checklist" data-testid="tab-checklist">
                Checklist
              </TabsTrigger>
              <TabsTrigger value="gtp" data-testid="tab-gtp">
                GTP cycle
              </TabsTrigger>
              <TabsTrigger value="cancellation" data-testid="tab-cancellation">
                Cancellation
              </TabsTrigger>
              <TabsTrigger value="audit" data-testid="tab-campaign-audit">
                Audit
              </TabsTrigger>
            </TabsList>

            <TabsContent value="checklist" className="pt-4">
              <div className="w-full space-y-3" data-testid="checklist-flow">
                {(campaign.checklist ?? []).map((item) => (
                  <ChecklistItem key={item.key} campaign={campaign} item={item} />
                ))}
                {campaign.stage !== "onboarding" && (
                  <p className="text-xs text-muted-foreground">
                    Onboarding is complete — this checklist is preserved as a permanent record.
                  </p>
                )}
              </div>
            </TabsContent>

            <TabsContent value="gtp" className="pt-4">
              {(campaign.gtps ?? []).length === 0 ? (
                <EmptyState
                  title="GTP schedule not created yet"
                  hint="The 28-day GTP cadence is generated from the campaign start date once Finance raises the invoice and the asset goes live."
                  testId="gtp-empty-state"
                />
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Schedule is anchored to the campaign start date — a delayed approval does not shift later
                    deadlines.
                  </p>
                  <div className="grid gap-3 lg:grid-cols-2" data-testid="gtp-list">
                    {campaign.gtps.map((g) => (
                      <GtpCard key={g.id} campaign={campaign} gtp={g} />
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="cancellation" className="pt-4">
              <CancellationPanel campaign={campaign} />
            </TabsContent>

            <TabsContent value="audit" className="pt-4">
              <AuditTrail entries={campaign.audit ?? []} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </AppShell>
  );
}
