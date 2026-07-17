'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType, WhatsAppProviderKind } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

const PROVIDERS: { value: WhatsAppProviderKind; label: string; description: string }[] = [
  {
    value: 'meta',
    label: 'Meta (API Oficial)',
    description: 'WhatsApp Business API oficial da Meta. Requer conta verificada no Meta Business.',
  },
  {
    value: 'zapi',
    label: 'Z-API',
    description: 'Conecta via z-api.io. Instância baseada em QR code, sem aprovação da Meta.',
  },
  {
    value: 'uazapi',
    label: 'uazapi',
    description: 'Compatible com Evolution API. Self-hosted ou cloud em uazapi.dev.',
  },
];

export function WhatsAppConfig() {
  // useMemo keeps the client reference stable across renders — without
  // this, createClient() returns a new object every render, which causes
  // fetchConfig (via useCallback) to be recreated, triggering the effect
  // again and resetting the provider selector back to whatever's in the DB.
  const supabase = useMemo(() => createClient(), []);
  const { user, accountId, canEditSettings, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Provider selector — persisted in sessionStorage so navigation away and
  // back doesn't reset it to whatever's in the DB before the user saves.
  const PROVIDER_DRAFT_KEY = 'wa-provider-draft';
  const [provider, setProvider] = useState<WhatsAppProviderKind>('meta');

  function changeProvider(val: WhatsAppProviderKind) {
    setProvider(val);
    try { sessionStorage.setItem(PROVIDER_DRAFT_KEY, val); } catch {}
  }

  function clearProviderDraft() {
    try { sessionStorage.removeItem(PROVIDER_DRAFT_KEY); } catch {}
  }

  // Meta fields
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // Non-Meta fields
  const [instanceId, setInstanceId] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [clientToken, setClientToken] = useState('');       // Z-API Security Token
  const [clientTokenEdited, setClientTokenEdited] = useState(false);
  const [showClientToken, setShowClientToken] = useState(false);

  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] = useState<RegistrationProbe | null>(null);

  // Webhook URL — for non-Meta providers it includes the verify_token as a path segment
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const webhookUrl =
    provider === 'meta'
      ? `${origin}/api/whatsapp/webhook`
      : verifyToken
        ? `${origin}/api/whatsapp/webhook/${provider}/${verifyToken}`
        : `${origin}/api/whatsapp/webhook/${provider}/{seu-verify-token}`;

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load config row:', error);
      }

      if (data) {
        setConfig(data);
        const savedProvider = (data.provider as WhatsAppProviderKind) ?? 'meta';
        // Prefer an unsaved user draft over whatever's in the DB, so navigating
        // away and back doesn't discard a pending provider switch.
        const draft = typeof window !== 'undefined'
          ? (sessionStorage.getItem(PROVIDER_DRAFT_KEY) as WhatsAppProviderKind | null)
          : null;
        const effectiveProvider = draft ?? savedProvider;
        setProvider(effectiveProvider);

        if (savedProvider === 'meta') {
          setPhoneNumberId(data.phone_number_id || '');
          setWabaId(data.waba_id || '');
          setAccessToken(MASKED_TOKEN);
          setVerifyToken('');
          setPin('');
          setTokenEdited(false);
          setInstanceId('');
          setBaseUrl('');
          setClientToken('');
        } else {
          setInstanceId(data.instance_id || '');
          setBaseUrl(data.base_url || '');
          setAccessToken(MASKED_TOKEN);
          setVerifyToken('');
          // waba_id stores the encrypted Security Token for Z-API; mask it if present
          setClientToken(savedProvider === 'zapi' && data.waba_id ? MASKED_TOKEN : '');
          setClientTokenEdited(false);
          setTokenEdited(false);
          setPhoneNumberId('');
          setWabaId('');
          setPin('');
        }
      } else {
        setConfig(null);
        // Restore draft even when there's no saved config
        const draft = typeof window !== 'undefined'
          ? (sessionStorage.getItem(PROVIDER_DRAFT_KEY) as WhatsAppProviderKind | null)
          : null;
        setProvider(draft ?? 'meta');
        setPhoneNumberId('');
        setWabaId('');
        setAccessToken('');
        setVerifyToken('');
        setPin('');
        setTokenEdited(false);
        setInstanceId('');
        setBaseUrl('');
        setClientToken('');
        setClientTokenEdited(false);
      }
      setRegistrationProbe(null);

      if (data) {
        try {
          const res = await fetch('/api/whatsapp/config', { method: 'GET' });
          const payload = await res.json();

          if (payload.connected) {
            setConnectionStatus('connected');
            setResetReason(null);
            setStatusMessage('');
          } else {
            setConnectionStatus('disconnected');
            setResetReason(
              payload.needs_reset
                ? 'token_corrupted'
                : payload.reason === 'meta_api_error'
                  ? 'meta_api_error'
                  : null,
            );
            setStatusMessage(payload.message || '');
          }
        } catch (err) {
          console.error('Health check failed:', err);
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(null);
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  async function handleSave() {
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Token de acesso é obrigatório para a configuração inicial');
      return;
    }

    const payload: Record<string, unknown> = { provider };

    if (provider === 'meta') {
      if (!phoneNumberId.trim()) {
        toast.error('Phone Number ID é obrigatório');
        return;
      }

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        toast.error('Por favor, insira novamente o Access Token para salvar alterações');
        setSaving(false);
        return;
      }

      payload.phone_number_id = phoneNumberId.trim();
      payload.waba_id = wabaId.trim() || null;
      payload.verify_token = verifyToken.trim() || null;
      payload.pin = pin.trim() || null;
    } else {
      // Non-Meta
      if (!instanceId.trim()) {
        toast.error('Instance ID é obrigatório');
        return;
      }
      if (provider === 'uazapi' && !baseUrl.trim()) {
        toast.error('URL do servidor é obrigatório para uazapi');
        return;
      }

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        toast.error('Por favor, insira novamente o Token para salvar alterações');
        setSaving(false);
        return;
      }

      payload.instance_id = instanceId.trim();
      payload.base_url = provider === 'uazapi' ? baseUrl.trim() : null;
      payload.verify_token = verifyToken.trim() || null;

      // Only send client_token for Z-API; only include it if the field was touched
      if (provider === 'zapi' && clientTokenEdited) {
        payload.client_token = clientToken !== MASKED_TOKEN ? (clientToken.trim() || null) : undefined;
      }
    }

    try {
      setSaving(true);

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        return;
      }

      if (data.registered === false && data.registration_error) {
        toast.error(
          `Salvo, mas a Meta não conseguiu registrar o número: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        toast.success(
          'Credenciais salvas e verificadas. Registro de entrada ignorado (sem PIN) — veja o status de registro abaixo.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          provider === 'meta'
            ? data.phone_info?.verified_name
              ? `Conectado — ${data.phone_info.verified_name} pode receber eventos.`
              : 'WhatsApp conectado. Eventos começarão a fluir em breve.'
            : 'Instância conectada com sucesso!',
        );
        setPin('');
      }

      // Provider is now persisted in the DB — clear the draft so future
      // navigation loads the saved provider rather than the old draft.
      clearProviderDraft();
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? `Conectado a ${payload.phone_info.verified_name}`
            : 'Conexão com a API bem-sucedida',
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(
          payload.needs_reset
            ? 'token_corrupted'
            : payload.reason === 'meta_api_error'
              ? 'meta_api_error'
              : null,
        );
        setStatusMessage(payload.message || '');
        toast.error(payload.message || 'Falha na conexão com a API');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error('Teste de conexão falhou. Verifique a rede e tente novamente.');
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', { method: 'GET' });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Número totalmente registrado — a Meta está entregando eventos.');
      } else {
        toast.error('Número não está totalmente registrado. Veja as verificações abaixo.', {
          duration: 8000,
        });
      }
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Não foi possível alcançar o endpoint de verificação.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (
      !confirm(
        'Isso excluirá a configuração atual do WhatsApp para que você possa inserir novamente. Continuar?',
      )
    ) {
      return;
    }

    try {
      setResetting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to reset configuration');
        return;
      }

      toast.success('Configuração apagada. Você pode inserir suas credenciais novamente.');
      clearProviderDraft();
      setConfig(null);
      setProvider('meta');
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setInstanceId('');
      setBaseUrl('');
      setClientToken('');
      setClientTokenEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('URL do webhook copiada para a área de transferência');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Conexão WhatsApp"
          description="Conecte seu WhatsApp Business. Escolha o provider, configure as credenciais e o webhook."
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';
  // `PROVIDERS` (the master list, includes zapi) stays untouched so this
  // lookup never returns undefined — that would crash the page for any
  // account with a legacy Z-API config.
  const selectedProviderInfo = PROVIDERS.find((p) => p.value === provider)!;

  // Z-API is an internal/testing-only provider — hidden from new
  // selections by default. Never hidden for an account that already has
  // it saved (config?.provider), so a legacy Z-API config keeps its
  // matching <option> and doesn't silently fall back to another provider.
  const zapiVisible =
    process.env.NEXT_PUBLIC_WHATSAPP_ENABLE_ZAPI === 'true' || config?.provider === 'zapi';
  const visibleProviders = PROVIDERS.filter((p) => p.value !== 'zapi' || zapiVisible);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Conexão WhatsApp"
        description="Conecte seu WhatsApp Business. Escolha o provider, configure as credenciais e o webhook."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main config form */}
        <div className="space-y-6">
          {/* Corrupted-token reset banner */}
          {showResetBanner && (
            <Alert className="bg-amber-950/40 border-amber-600/40">
              <div className="flex items-start gap-3">
                <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <AlertTitle className="text-amber-200 mb-1">
                    Token armazenado não pode ser descriptografado
                  </AlertTitle>
                  <AlertDescription className="text-amber-100/80 text-sm">
                    {statusMessage}
                  </AlertDescription>
                  {canEditSettings && (
                    <Button
                      onClick={handleReset}
                      disabled={resetting}
                      size="sm"
                      className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                    >
                      {resetting ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Resetando...
                        </>
                      ) : (
                        <>
                          <RotateCcw className="size-4" />
                          Resetar Configuração
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </Alert>
          )}

          {/* Connection Status */}
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {connectionStatus === 'connected' ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {connectionStatus === 'connected' ? 'Credenciais válidas' : 'Não conectado'}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {connectionStatus === 'connected'
                ? provider === 'meta'
                  ? 'Seu token de acesso autentica com a Meta. Veja o status de registro abaixo.'
                  : `Instância ${provider.toUpperCase()} conectada e respondendo.`
                : statusMessage ||
                  'Configure suas credenciais abaixo para conectar o WhatsApp Business.'}
            </AlertDescription>
          </Alert>

          {/* Meta-only: Registration Status */}
          {config && provider === 'meta' && (
            <Alert
              className={
                isRegistered
                  ? 'bg-emerald-950/30 border-emerald-700/50'
                  : 'bg-amber-950/30 border-amber-700/50'
              }
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  {isRegistered ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-4 text-amber-400" />
                  )}
                  <AlertTitle
                    className={'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')}
                  >
                    {isRegistered
                      ? 'Registrado — Meta entregará eventos ao wacrm'
                      : 'Não registrado — Meta não entregará eventos'}
                  </AlertTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyRegistration}
                  disabled={verifyingRegistration}
                  className="border-border bg-transparent text-foreground hover:bg-muted h-7"
                >
                  {verifyingRegistration ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  Verificar com Meta
                </Button>
              </div>
              <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {isRegistered ? (
                  <>
                    Inscrito desde{' '}
                    {config.registered_at
                      ? new Date(config.registered_at).toLocaleString('pt-BR')
                      : 'desconhecido'}
                    . Clique em <strong>Verificar com Meta</strong> se os eventos pararem de chegar.
                  </>
                ) : lastRegistrationError ? (
                  <>
                    Última tentativa falhou:{' '}
                    <span className="text-red-300">&quot;{lastRegistrationError}&quot;</span>. Insira
                    (ou corrija) o PIN de 2 etapas abaixo e clique em Salvar Configuração para
                    tentar novamente.
                  </>
                ) : (
                  <>
                    Este número foi salvo antes do rastreamento de registro existir, ou o registro
                    foi ignorado. Insira o PIN de 2 etapas abaixo e clique em Salvar Configuração.
                  </>
                )}
              </AlertDescription>

              {registrationProbe && (
                <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                  <p className="font-medium text-foreground">
                    Diagnóstico — última execução:{' '}
                    <span
                      className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}
                    >
                      {registrationProbe.live ? 'ativo' : 'inativo'}
                    </span>
                  </p>
                  <ul className="space-y-0.5 text-muted-foreground">
                    {Object.entries(registrationProbe.checks).map(([k, v]) => (
                      <li key={k} className="flex items-center gap-1.5">
                        {v === true ? (
                          <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                        ) : v === false ? (
                          <XCircle className="size-3 text-red-400 shrink-0" />
                        ) : (
                          <span className="size-3 rounded-full border border-border shrink-0" />
                        )}
                        <code className="text-muted-foreground">{k}</code>
                      </li>
                    ))}
                  </ul>
                  {(registrationProbe.errors ?? []).length > 0 && (
                    <ul className="pt-1 space-y-0.5 text-red-300">
                      {registrationProbe.errors?.map((e, i) => (
                        <li key={i}>• {e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Alert>
          )}

          {/* Provider Selector */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Provider</CardTitle>
              <CardDescription className="text-muted-foreground">
                Escolha como seu WhatsApp está conectado.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <select
                value={provider}
                onChange={(e) => changeProvider(e.target.value as WhatsAppProviderKind)}
                disabled={!canEditSettings}
                className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {visibleProviders.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">{selectedProviderInfo.description}</p>
            </CardContent>
          </Card>

          {/* Credentials Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Credenciais da API</CardTitle>
              <CardDescription className="text-muted-foreground">
                {provider === 'meta' && 'Credenciais da Meta WhatsApp Business API.'}
                {provider === 'zapi' && 'Credenciais da instância Z-API (z-api.io).'}
                {provider === 'uazapi' && 'Credenciais da instância uazapi.'}
              </CardDescription>
              {!canEditSettings && (
                <p className="text-xs text-muted-foreground">
                  Apenas admins da conta podem editar as configurações do WhatsApp.
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              {/* ── META FIELDS ── */}
              {provider === 'meta' && (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Phone Number ID</Label>
                    <Input
                      placeholder="ex: 100234567890123"
                      value={phoneNumberId}
                      onChange={(e) => setPhoneNumberId(e.target.value)}
                      disabled={!canEditSettings}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">WhatsApp Business Account ID (WABA)</Label>
                    <Input
                      placeholder="ex: 100234567890456"
                      value={wabaId}
                      onChange={(e) => setWabaId(e.target.value)}
                      disabled={!canEditSettings}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                </>
              )}

              {/* ── ZAPI FIELDS ── */}
              {provider === 'zapi' && (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Instance ID</Label>
                    <Input
                      placeholder="ex: 3D3F0E4E1B1C1D1E1F1A1B1C"
                      value={instanceId}
                      onChange={(e) => setInstanceId(e.target.value)}
                      disabled={!canEditSettings}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <p className="text-xs text-muted-foreground">
                      Encontrado no painel Z-API → sua instância → Instance ID.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">
                      Security Token (Client-Token)
                      <span className="ml-1 text-xs text-muted-foreground">(opcional)</span>
                    </Label>
                    <div className="relative">
                      <Input
                        type={showClientToken ? 'text' : 'password'}
                        placeholder="Security Token da instância Z-API"
                        value={clientToken}
                        onChange={(e) => { setClientToken(e.target.value); setClientTokenEdited(true); }}
                        onFocus={() => {
                          if (clientToken === MASKED_TOKEN) {
                            setClientToken('');
                            setClientTokenEdited(true);
                          }
                        }}
                        disabled={!canEditSettings}
                        className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                      <button
                        type="button"
                        onClick={() => setShowClientToken(!showClientToken)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showClientToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Necessário para integrações externas (Make, n8n, etc.). No painel Z-API → ⚙️ Segurança → Security Token. Deixe em branco para remover.
                    </p>
                  </div>
                </>
              )}

              {/* ── UAZAPI FIELDS ── */}
              {provider === 'uazapi' && (
                <>
                  <div className="space-y-2">
                    <Label className="text-muted-foreground">URL do servidor</Label>
                    <Input
                      placeholder="ex: https://meu-servidor.uazapi.dev"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={!canEditSettings}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label className="text-muted-foreground">Nome da instância</Label>
                    <Input
                      placeholder="ex: minha-instancia"
                      value={instanceId}
                      onChange={(e) => setInstanceId(e.target.value)}
                      disabled={!canEditSettings}
                      className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                </>
              )}

              {/* Access Token (all providers) */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {provider === 'meta' ? 'Permanent Access Token' : 'Token / API Key'}
                </Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder={
                      provider === 'meta'
                        ? 'Cole seu access token'
                        : provider === 'zapi'
                          ? 'Token da instância Z-API'
                          : 'API Key do uazapi'
                    }
                    value={accessToken}
                    onChange={(e) => {
                      setAccessToken(e.target.value);
                      setTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (accessToken === MASKED_TOKEN) {
                        setAccessToken('');
                        setTokenEdited(true);
                      }
                    }}
                    disabled={!canEditSettings}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10 disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {config && !tokenEdited && (
                  <p className="text-xs text-muted-foreground">
                    Token oculto por segurança. Insira novamente para atualizar a configuração.
                  </p>
                )}
              </div>

              {/* Webhook Verify Token (all providers) */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Webhook Verify Token
                  {provider !== 'meta' && (
                    <span className="ml-1 text-amber-400 text-xs">(necessário para inbound)</span>
                  )}
                </Label>
                <Input
                  placeholder={
                    provider === 'meta'
                      ? 'Crie um token personalizado'
                      : 'Crie um segredo para proteger o webhook'
                  }
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  disabled={!canEditSettings}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
                />
                {provider === 'meta' ? (
                  <p className="text-xs text-muted-foreground">
                    String personalizada. Deve coincidir com o token configurado no painel de webhooks da Meta.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Este valor será incluído na URL do webhook abaixo. Configure essa URL no painel do{' '}
                    {provider === 'zapi' ? 'Z-API' : 'uazapi'} para receber mensagens.
                  </p>
                )}
              </div>

              {/* Meta-only: 2-step PIN */}
              {provider === 'meta' && (
                <div className="space-y-2">
                  <Label className="text-muted-foreground">
                    PIN de verificação em duas etapas
                    <span className="ml-1 text-muted-foreground">(opcional)</span>
                  </Label>
                  <Input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="PIN de 6 dígitos do Meta WhatsApp Manager"
                    value={pin}
                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    disabled={!canEditSettings}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest disabled:cursor-not-allowed disabled:opacity-60"
                  />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Necessário apenas para conectar mensagens <strong className="text-muted-foreground">inbound</strong> em
                    números <strong className="text-muted-foreground">de produção</strong>. Configure no{' '}
                    <strong className="text-muted-foreground">Meta Business Manager → Contas do WhatsApp → Números de telefone → Verificação em duas etapas</strong>.
                    Números de teste da Meta não precisam de PIN — deixe em branco.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Webhook URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Configuração do Webhook</CardTitle>
              <CardDescription className="text-muted-foreground">
                {provider === 'meta'
                  ? 'Use esta URL como callback no painel do Meta App.'
                  : `Configure esta URL como webhook no painel do ${provider === 'zapi' ? 'Z-API' : 'uazapi'}.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">URL do Webhook</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopyWebhookUrl}
                    className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
                {provider !== 'meta' && !verifyToken && (
                  <p className="text-xs text-amber-400">
                    Preencha o Webhook Verify Token acima para gerar a URL final.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            {canEditSettings && (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Salvando...
                  </>
                ) : (
                  'Salvar Configuração'
                )}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !config}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Testando...
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  Testar Conexão
                </>
              )}
            </Button>
            {config && canEditSettings && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {resetting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Resetando...
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    Resetar Configuração
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Setup Instructions Sidebar */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">
                {provider === 'meta' && 'Configuração Meta API'}
                {provider === 'zapi' && 'Configuração Z-API'}
                {provider === 'uazapi' && 'Configuração uazapi'}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                Siga os passos para conectar seu WhatsApp Business.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {provider === 'meta' && (
                <Accordion>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                        Criar um Meta App
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse <span className="text-primary">developers.facebook.com</span></li>
                        <li>Clique em &quot;Meus Apps&quot; → &quot;Criar App&quot;</li>
                        <li>Selecione &quot;Business&quot; como tipo</li>
                        <li>Preencha os detalhes e crie</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                        Adicionar produto WhatsApp
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>No painel do app, clique em &quot;Adicionar produto&quot;</li>
                        <li>Encontre &quot;WhatsApp&quot; e clique em &quot;Configurar&quot;</li>
                        <li>Siga o assistente para vincular seu negócio</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                        Obter credenciais
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Vá em WhatsApp &gt; Configuração da API</li>
                        <li>Copie seu <strong className="text-foreground">Phone Number ID</strong></li>
                        <li>Copie seu <strong className="text-foreground">WhatsApp Business Account ID</strong></li>
                        <li>Gere um <strong className="text-foreground">Permanent Access Token</strong> em Configurações do negócio &gt; Usuários do sistema</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                        Configurar Webhooks
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Vá em WhatsApp &gt; Configuração</li>
                        <li>Clique em &quot;Editar&quot; na seção Webhook</li>
                        <li>Cole a <strong className="text-foreground">URL do Webhook</strong> acima</li>
                        <li>Digite o mesmo <strong className="text-foreground">Verify Token</strong> que você configurou aqui</li>
                        <li>Assine o campo de webhook &quot;messages&quot;</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {provider === 'zapi' && (
                <Accordion>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                        Criar instância no Z-API
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse <span className="text-primary">app.z-api.io</span></li>
                        <li>Crie uma nova instância</li>
                        <li>Copie o <strong className="text-foreground">Instance ID</strong> e o <strong className="text-foreground">Token</strong></li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                        Conectar via QR Code
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>No painel Z-API, abra sua instância</li>
                        <li>Clique em &quot;Conectar&quot; e escaneie o QR Code com o WhatsApp</li>
                        <li>Aguarde o status mostrar &quot;Connected&quot;</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                        Configurar webhook de entrada
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Defina um <strong className="text-foreground">Verify Token</strong> no formulário</li>
                        <li>Salve a configuração aqui</li>
                        <li>No Z-API, vá em Webhook e cole a <strong className="text-foreground">URL do Webhook</strong> gerada acima</li>
                        <li>Ative os eventos de mensagem recebida</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              {provider === 'uazapi' && (
                <Accordion>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                        Configurar servidor uazapi
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse seu servidor uazapi (self-hosted ou <span className="text-primary">uazapi.dev</span>)</li>
                        <li>Crie uma instância no painel</li>
                        <li>Copie a <strong className="text-foreground">API Key</strong> e o <strong className="text-foreground">nome da instância</strong></li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                        Conectar via QR Code
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Acesse a interface do uazapi</li>
                        <li>Gere o QR code e escaneie com o WhatsApp</li>
                        <li>Aguarde o estado mostrar &quot;open&quot;</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem className="border-border">
                    <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                      <span className="flex items-center gap-2">
                        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                        Configurar webhook
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground">
                      <ol className="list-decimal list-inside space-y-1 text-sm">
                        <li>Defina um <strong className="text-foreground">Verify Token</strong> no formulário</li>
                        <li>Salve a configuração aqui</li>
                        <li>No uazapi, configure o webhook da instância com a <strong className="text-foreground">URL do Webhook</strong> gerada</li>
                        <li>Ative os eventos MESSAGES_UPSERT</li>
                      </ol>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              )}

              <div className="mt-4 pt-4 border-t border-border">
                {provider === 'meta' && (
                  <a
                    href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Documentação Meta WhatsApp API
                  </a>
                )}
                {provider === 'zapi' && (
                  <a
                    href="https://developer.z-api.io"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Documentação Z-API
                  </a>
                )}
                {provider === 'uazapi' && (
                  <a
                    href="https://uazapi.dev/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <ExternalLink className="size-3.5" />
                    Documentação uazapi
                  </a>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
