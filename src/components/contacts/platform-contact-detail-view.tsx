'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { usePlatformContext } from '@/hooks/use-platform-context';
import {
  createContactDetailLoader,
  type ContactDetailData,
} from '@/lib/contacts/detail-state';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format } from 'date-fns';
import {
  Loader2,
  AlertTriangle,
  SearchX,
  User,
  Phone,
  Mail,
  Building2,
  Tag as TagIcon,
  StickyNote,
  DollarSign,
  ListChecks,
  Megaphone,
} from 'lucide-react';

// Platform read-only Contact DETAIL view (Option C: a platform-only component,
// NOT a reuse of the member ContactDetailView). It renders a supervised
// tenant's contact with ZERO write affordances — no inputs, no save/add/delete,
// no ContactForm/ImportModal/CustomFieldsManager. Read-only is enforced
// structurally (no mutation UI exists), NOT via useCan() gating.
//
// The ONLY tenant source is usePlatformContext().activeAccountId — never
// useAuth(), never a route param on the client. Every read goes through the
// existing queries.ts functions via the detail loader, which filters by that
// explicit accountId; a contactId from another tenant resolves to a "not
// found" state (getContactById returns null), never another tenant's data.
//
// The detail loader owns an INDEPENDENT sequence guard. A single effect keyed
// on {open, contactId, activeAccountId} resets the loader on every change —
// selecting a different contact, switching tenants, or closing — so an
// in-flight response for contact/tenant A can never populate the Sheet after
// the operator moved on. The effect-cleanup `active` flag is a second guard so
// a late resolve/reject after a tenant switch cannot set state.
interface PlatformContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
}

type DetailView =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not_found' }
  | { kind: 'found'; data: ContactDetailData };

export function PlatformContactDetailView({
  open,
  onOpenChange,
  contactId,
}: PlatformContactDetailViewProps) {
  const { activeAccountId } = usePlatformContext();
  const supabaseRef = useRef(createClient());
  const loaderRef = useRef(createContactDetailLoader());

  const [view, setView] = useState<DetailView>({ kind: 'idle' });

  useEffect(() => {
    let active = true;

    // Any change (contact select, tenant switch, close) supersedes an in-flight
    // load: bump the loader sequence so its pending response resolves to null.
    loaderRef.current.reset();

    if (!open || !contactId || !activeAccountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView({ kind: 'idle' });
      return () => {
        active = false;
      };
    }

    setView({ kind: 'loading' });
    loaderRef.current
      .load({ supabase: supabaseRef.current, accountId: activeAccountId, contactId })
      .then((res) => {
        if (!active || res === null) return; // unmounted / superseded
        if (res.status === 'not_found') setView({ kind: 'not_found' });
        else setView({ kind: 'found', data: res.data });
      })
      .catch((err) => {
        if (!active) return;
        setView({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Failed to load contact.',
        });
      });

    return () => {
      active = false;
    };
  }, [open, contactId, activeAccountId]);

  const title =
    view.kind === 'found'
      ? view.data.contact.name || view.data.contact.phone || 'Contact'
      : 'Contact';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <SheetHeader className="p-4 border-b border-border/50">
          <SheetTitle className="text-foreground">{title}</SheetTitle>
          <SheetDescription className="text-muted-foreground">
            Read-only tenant view.
          </SheetDescription>
        </SheetHeader>

        {view.kind === 'loading' || view.kind === 'idle' ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : view.kind === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertTriangle className="size-8 text-destructive" />
            <p className="text-sm text-destructive">{view.message}</p>
          </div>
        ) : view.kind === 'not_found' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <SearchX className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Contact not found</p>
            <p className="text-xs text-muted-foreground">
              This contact does not exist in the current tenant, or is no longer
              available.
            </p>
          </div>
        ) : (
          <FoundDetail data={view.data} />
        )}
      </SheetContent>
    </Sheet>
  );
}

// ------------------------------------------------------------
// Read-only detail body. No inputs, no buttons, no mutations.
// ------------------------------------------------------------

function FoundDetail({ data }: { data: ContactDetailData }) {
  const { contact, tags, notes, customFields, customValues, deals, attribution } = data;

  return (
    <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="mx-4 mt-3 flex-wrap bg-muted/50">
        <TabsTrigger value="details" className="text-muted-foreground data-active:text-primary">
          Details
        </TabsTrigger>
        <TabsTrigger value="tags" className="text-muted-foreground data-active:text-primary">
          Tags
        </TabsTrigger>
        <TabsTrigger value="notes" className="text-muted-foreground data-active:text-primary">
          Notes
        </TabsTrigger>
        <TabsTrigger value="custom" className="text-muted-foreground data-active:text-primary">
          Custom Fields
        </TabsTrigger>
        <TabsTrigger value="deals" className="text-muted-foreground data-active:text-primary">
          Deals
        </TabsTrigger>
        <TabsTrigger value="attribution" className="text-muted-foreground data-active:text-primary">
          Attribution
        </TabsTrigger>
      </TabsList>

      <ScrollArea className="min-h-0 flex-1">
        {/* Details — plain, non-editable rows */}
        <TabsContent value="details" className="space-y-3 p-4">
          <ReadRow icon={<User className="size-4" />} label="Name">
            {contact.name || <Muted>Unnamed</Muted>}
          </ReadRow>
          <ReadRow icon={<Phone className="size-4" />} label="Phone">
            <span className="font-mono text-xs">{contact.phone}</span>
          </ReadRow>
          <ReadRow icon={<Mail className="size-4" />} label="Email">
            {contact.email || <Muted>—</Muted>}
          </ReadRow>
          <ReadRow icon={<Building2 className="size-4" />} label="Company">
            {contact.company || <Muted>—</Muted>}
          </ReadRow>
        </TabsContent>

        {/* Tags — view only */}
        <TabsContent value="tags" className="p-4">
          <SectionLabel icon={<TagIcon className="size-3" />}>Tags</SectionLabel>
          {tags.length === 0 ? (
            <EmptyState>No tags on this contact.</EmptyState>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: (tag.color ?? '#888') + '20',
                    color: tag.color ?? '#888',
                  }}
                >
                  {tag.name}
                </span>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Notes — view only (no textarea, no add, no delete) */}
        <TabsContent value="notes" className="p-4">
          <SectionLabel icon={<StickyNote className="size-3" />}>Notes</SectionLabel>
          {notes.length === 0 ? (
            <EmptyState>No notes on this contact.</EmptyState>
          ) : (
            <div className="mt-2 space-y-2">
              {notes.map((note) => (
                <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                  <p className="whitespace-pre-wrap text-xs text-foreground">
                    {note.note_text}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {format(new Date(note.created_at), 'MMM d, yyyy HH:mm')}
                  </p>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Custom Fields — view only */}
        <TabsContent value="custom" className="p-4">
          <SectionLabel icon={<ListChecks className="size-3" />}>Custom Fields</SectionLabel>
          {customFields.length === 0 ? (
            <EmptyState>No custom fields defined for this tenant.</EmptyState>
          ) : (
            <div className="mt-2 space-y-2">
              {customFields.map((field) => (
                <div key={field.id} className="rounded-lg bg-muted px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {field.field_name}
                  </p>
                  <p className="text-sm text-foreground">
                    {customValues[field.id]?.trim() ? customValues[field.id] : <Muted>—</Muted>}
                  </p>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Deals — view only */}
        <TabsContent value="deals" className="p-4">
          <SectionLabel icon={<DollarSign className="size-3" />}>Deals</SectionLabel>
          {deals.length === 0 ? (
            <EmptyState>No deals linked to this contact.</EmptyState>
          ) : (
            <div className="mt-2 space-y-2">
              {deals.map((deal) => (
                <div key={deal.id} className="rounded-lg bg-muted px-3 py-2">
                  <p className="text-sm font-medium text-foreground">{deal.title}</p>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {deal.currency ?? '$'}
                      {deal.value.toLocaleString()}
                    </span>
                    {deal.stage && (
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: (deal.stage.color ?? '#888') + '20',
                          color: deal.stage.color ?? '#888',
                        }}
                      >
                        {deal.stage.name}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Attribution — shown only if present; absence is a NORMAL state */}
        <TabsContent value="attribution" className="p-4">
          <SectionLabel icon={<Megaphone className="size-3" />}>Lead Origin</SectionLabel>
          {!attribution ? (
            <EmptyState>No attribution recorded for this contact.</EmptyState>
          ) : (
            <div className="mt-2 overflow-hidden rounded-lg border border-border">
              {attribution.ad_media_url && (
                <img
                  src={attribution.ad_media_url}
                  alt={attribution.ad_headline ?? 'Ad creative'}
                  className="h-28 w-full object-cover"
                />
              )}
              <div className="space-y-1 bg-muted px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {attribution.source_channel}
                </p>
                {attribution.ad_headline && (
                  <p className="text-xs font-semibold text-foreground">
                    {attribution.ad_headline}
                  </p>
                )}
                {attribution.ad_body && (
                  <p className="text-xs text-muted-foreground">{attribution.ad_body}</p>
                )}
                {(attribution.campaign_name || attribution.adset_name) && (
                  <p className="text-[10px] text-muted-foreground">
                    {attribution.campaign_name}
                    {attribution.adset_name ? ` · ${attribution.adset_name}` : ''}
                  </p>
                )}
                <p className="pt-1 text-[10px] text-muted-foreground">
                  Captured {format(new Date(attribution.created_at), 'MMM d, yyyy HH:mm')}
                </p>
              </div>
            </div>
          )}
        </TabsContent>
      </ScrollArea>
    </Tabs>
  );
}

function ReadRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <div className="text-sm text-foreground break-words">{children}</div>
      </div>
    </div>
  );
}

function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 px-1 text-xs text-muted-foreground">{children}</p>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="italic text-muted-foreground">{children}</span>;
}
