import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Switch, StyleSheet, Alert } from 'react-native'
import { useNavigation } from 'expo-router'
import { Laptop, Smartphone, Play, Pause, SkipBack, SkipForward, Cast, ArrowLeftRight } from 'lucide-react-native'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import { useNavidromeStore } from '@/store/navidromeStore'
import { useDowntifyStore } from '@/store/downtifyStore'
import { useToastStore } from '@/store/toastStore'
import { EmptyState } from '@/components/Screen'
import { colors, radius, spacing, tint } from '@/constants/theme'
import { checkHealth, HealthResult, isValidServerUrl, normalizeServerUrl } from '@/services/hubServer'
import { useListeningStore } from '@/services/listeningLog'

function formatRelativeTime(updatedAt: number): string {
  const ms = updatedAt < 1e12 ? updatedAt * 1000 : updatedAt
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) return "À l'instant"
  if (diffSec < 3600) return `Il y a ${Math.floor(diffSec / 60)} min`
  if (diffSec < 86400) return `Il y a ${Math.floor(diffSec / 3600)} h`
  return `Il y a ${Math.floor(diffSec / 86400)} j`
}

function statusLabel(enabled: boolean, status: string, error: string | null, serverUrl = '', serverUser: string | null = null): string {
  if (!enabled) return 'Désactivé'
  if (serverUrl) {
    if (status === 'connected') return serverUser ? `Connecté en tant que ${serverUser}` : 'Connecté au serveur'
    if (status === 'connecting') return 'Connexion…'
    if (status === 'error') return `Refusé : ${error || 'connexion impossible'}`
    return 'Non connecté'
  }
  if (status === 'connected') return 'Connecté au PC'
  if (status === 'connecting') return 'Recherche du PC sur le réseau…'
  if (status === 'error') return error || 'Connexion impossible'
  return 'Non connecté'
}

export default function DevicesScreen() {
  const navigation = useNavigation()
  const enabled = useRemoteStore((s) => s.enabled)
  const status = useRemoteStore((s) => s.status)
  const error = useRemoteStore((s) => s.error)
  const deviceName = useRemoteStore((s) => s.deviceName)
  const deviceList = useRemoteStore((s) => s.deviceList)
  const devices = useRemoteStore((s) => s.devices)
  const selectedDeviceId = useRemoteStore((s) => s.selectedDeviceId)
  const setEnabled = useRemoteStore((s) => s.setEnabled)
  const setDeviceName = useRemoteStore((s) => s.setDeviceName)
  const connectManual = useRemoteStore((s) => s.connectManual)
  const autoConnect = useRemoteStore((s) => s.autoConnect)
  const pairing = useRemoteStore((s) => s.pairing)
  const pair = useRemoteStore((s) => s.pair)
  const unpair = useRemoteStore((s) => s.unpair)
  const selectDevice = useRemoteStore((s) => s.selectDevice)
  const switchOutput = useRemoteStore((s) => s.switchOutput)
  const sendCommand = useRemoteStore((s) => s.sendCommand)
  const serverUrl = useRemoteStore((s) => s.serverUrl)
  const serverUser = useRemoteStore((s) => s.serverUser)
  const setServerUrl = useRemoteStore((s) => s.setServerUrl)
  const syncedDevices = useListeningStore((s) => s.devices)
  const handoffToHere = useRemoteStore((s) => s.handoffToHere)
  const handoffToDevice = useRemoteStore((s) => s.handoffToDevice)
  const resumeState = useRemoteStore((s) => s.resumeState)
  const applyResume = useRemoteStore((s) => s.applyResume)
  const dismissResume = useRemoteStore((s) => s.dismissResume)
  const downtifyStatus = useDowntifyStore((s) => s.status)
  const downtifyViaHub = useDowntifyStore((s) => s.viaHub)
  const localSong = useNavidromeStore((s) => s.queue[s.queueIndex] || null)
  const localIsPlaying = useNavidromeStore((s) => s.isPlaying)
  const hasLocalSong = localSong !== null
  const showToast = useToastStore((s) => s.show)

  const [serverDraft, setServerDraft] = useState(serverUrl)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<HealthResult | null>(null)
  const [nameDraft, setNameDraft] = useState(deviceName)
  const [manualIp, setManualIp] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    navigation.setOptions({ title: 'Contrôle à distance' })
  }, [])

  useEffect(() => setNameDraft(deviceName), [deviceName])
  useEffect(() => setServerDraft(serverUrl), [serverUrl])

  async function handleTestServer(): Promise<void> {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await checkHealth(serverDraft))
    } finally {
      setTesting(false)
    }
  }

  async function handleSaveServer(): Promise<void> {
    const url = normalizeServerUrl(serverDraft)
    if (!url || !isValidServerUrl(url)) {
      setTestResult({ ok: false, error: 'Adresse invalide' })
      return
    }
    setSaving(true)
    try {
      const ok = await setServerUrl(url)
      if (ok) setServerDraft(url)
    } finally {
      setSaving(false)
    }
  }

  function confirmRemoveServer(): void {
    Alert.alert('Retirer le serveur ?', "Le contrôle à distance repasse par le réseau local, et le récap d'écoute n'est plus partagé avec les autres appareils.", [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Retirer',
        style: 'destructive',
        onPress: () => {
          setTestResult(null)
          void setServerUrl('')
        }
      }
    ])
  }

  const otherDevices = deviceList.filter((d) => d.deviceId !== LOCAL_DEVICE_ID)
  const selected = selectedDeviceId !== LOCAL_DEVICE_ID ? devices[selectedDeviceId] : null
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

  async function handlePair(): Promise<void> {
    setConnecting(true)
    const ok = await pair(codeDraft, manualIp.trim() || undefined)
    setConnecting(false)
    if (ok) setCodeDraft('')
  }

  function confirmUnpair(): void {
    Alert.alert('Dissocier du PC ?', 'Ce téléphone ne pourra plus piloter le PC (ni l\'inverse) avant d\'être appairé de nouveau avec le code du PC.', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Dissocier', style: 'destructive', onPress: () => void unpair() }
    ])
  }

  /** With an address, the PC there; without one, the paired PC looked for on the network again. */
  async function handleManualConnect(): Promise<void> {
    setConnecting(true)
    try {
      if (manualIp.trim()) await connectManual(manualIp.trim())
      else await autoConnect()
    } finally {
      setConnecting(false)
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {resumeState?.state?.song && (
        <View style={styles.resumeCard}>
          <View style={styles.resumeHeader}>
            {resumeState.platform === 'desktop' ? (
              <Laptop size={18} color={colors.accent} />
            ) : (
              <Smartphone size={18} color={colors.accent} />
            )}
            <Text style={styles.resumeHeaderText} numberOfLines={1}>
              Reprendre depuis {resumeState.deviceName}
            </Text>
          </View>
          <Text style={styles.resumeTrack} numberOfLines={1}>
            {resumeState.state.song.title}
          </Text>
          <Text style={styles.resumeMeta} numberOfLines={1}>
            {resumeState.state.song.artist} · {formatRelativeTime(resumeState.updatedAt)}
          </Text>
          <View style={styles.serverButtons}>
            <Pressable
              style={({ pressed }) => [styles.connectButton, styles.serverButton, pressed && styles.pressed]}
              onPress={() => {
                if (applyResume()) showToast(`Lecture reprise depuis ${resumeState.deviceName}`)
              }}
              accessibilityRole="button"
              accessibilityLabel={`Reprendre depuis ${resumeState.deviceName}`}
            >
              <Text style={styles.connectButtonText}>Reprendre</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.removeButton, styles.serverButton, pressed && styles.pressed]}
              onPress={dismissResume}
              accessibilityRole="button"
              accessibilityLabel="Ignorer la reprise"
            >
              <Text style={styles.removeButtonText}>Ignorer</Text>
            </Pressable>
          </View>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.fieldLabel}>Serveur SelfHost Hub</Text>
        <Text style={styles.pairHint}>
          Avec un serveur, le contrôle à distance et le récap d'écoute passent par votre serveur, chez vous comme à l'extérieur. Sans
          serveur, le PC et le téléphone se trouvent sur le réseau local.
        </Text>
        <TextInput
          style={styles.input}
          value={serverDraft}
          onChangeText={(text) => {
            setServerDraft(text)
            setTestResult(null)
          }}
          placeholder="https://hub.mondomaine.fr ou http://192.168.1.10:51823"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Adresse du serveur SelfHost Hub"
        />
        <View style={styles.serverButtons}>
          <Pressable
            style={({ pressed }) => [styles.connectButton, styles.serverButton, (testing || pressed) && styles.pressed]}
            onPress={handleTestServer}
            disabled={testing || !serverDraft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Tester le serveur"
          >
            {testing ? <ActivityIndicator color="#000" /> : <Text style={styles.connectButtonText}>Tester</Text>}
          </Pressable>
          <Pressable
            style={({ pressed }) => [styles.connectButton, styles.serverButton, (saving || pressed) && styles.pressed]}
            onPress={handleSaveServer}
            disabled={saving || !serverDraft.trim()}
            accessibilityRole="button"
            accessibilityLabel="Enregistrer le serveur"
          >
            {saving ? <ActivityIndicator color="#000" /> : <Text style={styles.connectButtonText}>Enregistrer</Text>}
          </Pressable>
          {serverUrl !== '' && (
            <Pressable
              style={({ pressed }) => [styles.removeButton, styles.serverButton, pressed && styles.pressed]}
              onPress={confirmRemoveServer}
              accessibilityRole="button"
              accessibilityLabel="Retirer le serveur"
            >
              <Text style={styles.removeButtonText}>Retirer</Text>
            </Pressable>
          )}
        </View>
        {testResult && (
          <Text style={[styles.serverStatus, testResult.ok ? styles.serverOk : styles.serverBad]}>
            {testResult.ok
              ? `Serveur trouvé : ${testResult.name || 'SelfHost Hub'}${testResult.version ? ` (version ${testResult.version})` : ''}`
              : testResult.error}
          </Text>
        )}
        {serverUrl !== '' && (
          <>
            <Text style={styles.serverStatus}>{statusLabel(enabled, status, error, serverUrl, serverUser)}</Text>
            <Text style={styles.serverStatus}>
              Synchronisé avec : {syncedDevices.length > 0 ? syncedDevices.map((d) => d.deviceName).join(', ') : 'aucun autre appareil pour l\'instant'}
            </Text>
            {downtifyStatus === 'connected' && downtifyViaHub && (
              <Text style={[styles.serverStatus, styles.serverOk]}>Downtify : via serveur Hub</Text>
            )}
          </>
        )}
      </View>

      <View style={styles.row}>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle}>Activer le contrôle à distance</Text>
          <Text style={styles.rowMeta}>{statusLabel(enabled, status, error, serverUrl, serverUser)}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          trackColor={{ false: colors.hover, true: colors.accent }}
          thumbColor="#fff"
        />
      </View>

      {enabled && (
        <>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Nom de ce téléphone</Text>
            <TextInput
              style={styles.input}
              value={nameDraft}
              onChangeText={setNameDraft}
              onBlur={() => nameDraft.trim() && setDeviceName(nameDraft.trim())}
              autoCapitalize="words"
              accessibilityLabel="Nom de ce téléphone"
            />
          </View>

          {!pairing && !serverUrl && (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>Appairer avec le PC</Text>
              <Text style={styles.pairHint}>
                Sur le PC : Réglages, rubrique « Contrôle à distance », « Code d'appairage ». Saisissez-le ici une seule fois :
                il n'est jamais envoyé sur le réseau.
              </Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={codeDraft}
                onChangeText={(text) => setCodeDraft(text.toUpperCase())}
                placeholder="ABCDE-FGHJK"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={14}
                accessibilityLabel="Code d'appairage du PC"
              />
              {status === 'error' && (
                <>
                  <Text style={styles.fieldLabel}>Adresse IP du PC (seulement s'il n'est pas trouvé tout seul)</Text>
                  <TextInput
                    style={styles.input}
                    value={manualIp}
                    onChangeText={setManualIp}
                    placeholder="192.168.1.42"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="numbers-and-punctuation"
                    accessibilityLabel="Adresse IP du PC"
                  />
                </>
              )}
              <Pressable
                style={({ pressed }) => [styles.connectButton, styles.pairButton, (connecting || pressed) && styles.pressed]}
                onPress={handlePair}
                disabled={connecting}
                accessibilityRole="button"
                accessibilityLabel="Appairer"
              >
                {connecting ? <ActivityIndicator color="#000" /> : <Text style={styles.connectButtonText}>Appairer</Text>}
              </Pressable>
            </View>
          )}

          {pairing && !serverUrl && (status === 'error' || status === 'disconnected') && (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>PC introuvable automatiquement ? Son adresse IP (laisser vide pour le chercher de nouveau)</Text>
              <View style={styles.manualRow}>
                <TextInput
                  style={[styles.input, styles.manualInput]}
                  value={manualIp}
                  onChangeText={setManualIp}
                  placeholder="192.168.1.42"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Adresse IP du PC"
                />
                <Pressable
                  style={({ pressed }) => [styles.connectButton, (connecting || pressed) && styles.pressed]}
                  onPress={handleManualConnect}
                  disabled={connecting}
                  accessibilityRole="button"
                  accessibilityLabel="Se connecter"
                >
                  {connecting ? <ActivityIndicator color="#000" /> : <Text style={styles.connectButtonText}>Connecter</Text>}
                </Pressable>
              </View>
            </View>
          )}

          {pairing && !serverUrl && (
            <Pressable onPress={confirmUnpair} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dissocier ce téléphone du PC">
              <Text style={styles.unpair}>Appairé avec un PC · Dissocier</Text>
            </Pressable>
          )}

          {status === 'connected' && (() => {
            const localSelected = selectedDeviceId === LOCAL_DEVICE_ID
            const localPlaying = localIsPlaying && !!localSong
            const anyPlaying =
              localPlaying || otherDevices.some((d) => Boolean(devices[d.deviceId]?.isPlaying && devices[d.deviceId]?.song))

            const handleSwitchLocal = () => {
              const transferred = !localPlaying && anyPlaying
              if (switchOutput(LOCAL_DEVICE_ID) && transferred) {
                showToast('Lecture reprise sur ce téléphone')
              }
            }

            return (
              <View style={styles.sectionSpacer}>
                <Text style={styles.sectionTitle}>Lire sur</Text>

                <View style={[styles.deviceCard, localSelected && styles.deviceRowActive]}>
                  <Pressable style={styles.deviceRowInner} onPress={handleSwitchLocal}>
                    <Smartphone size={18} color={localSelected ? colors.accent : colors.textSecondary} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={[styles.deviceName, localSelected && styles.deviceNameActive]} numberOfLines={1}>
                        Ce téléphone
                      </Text>
                      {localSong && (
                        <Text style={styles.deviceSubtitle} numberOfLines={1}>
                          {localSong.title} · {localSong.artist}
                        </Text>
                      )}
                    </View>
                  </Pressable>
                  {(localPlaying || localSelected) && (
                    <View style={styles.badgeRow}>
                      {localPlaying && (
                        <View style={[styles.badge, styles.badgePlaying]}>
                          <Text style={styles.badgePlayingText}>En cours de lecture</Text>
                        </View>
                      )}
                      {localSelected && (
                        <View style={[styles.badge, styles.badgeControlled]}>
                          <Text style={styles.badgeControlledText}>Contrôlé</Text>
                        </View>
                      )}
                    </View>
                  )}
                  {!localPlaying && anyPlaying && (
                    <View style={styles.handoffRow}>
                      <Pressable
                        style={({ pressed }) => [styles.handoffChip, styles.handoffChipPrimary, pressed && styles.pressed]}
                        onPress={handleSwitchLocal}
                        accessibilityRole="button"
                        accessibilityLabel="Passer l'écoute sur ce téléphone"
                      >
                        <ArrowLeftRight size={13} color={colors.accent} />
                        <Text style={[styles.handoffChipText, { color: colors.accent }]}>Passer l'écoute ici</Text>
                      </Pressable>
                    </View>
                  )}
                </View>

                {otherDevices.map((d) => {
                  const state = devices[d.deviceId]
                  const isSelected = selectedDeviceId === d.deviceId
                  const isDevicePlaying = Boolean(state?.isPlaying && state?.song)

                  const handleSwitchRemote = () => {
                    const willTransfer = localPlaying
                    if (switchOutput(d.deviceId) && willTransfer) {
                      showToast(`Lecture transférée vers ${d.deviceName}`)
                    }
                  }

                  return (
                    <View key={d.deviceId} style={[styles.deviceCard, isSelected && styles.deviceRowActive]}>
                      <Pressable style={styles.deviceRowInner} onPress={handleSwitchRemote}>
                        {d.platform === 'desktop' ? (
                          <Laptop size={18} color={isSelected ? colors.accent : colors.textSecondary} />
                        ) : (
                          <Smartphone size={18} color={isSelected ? colors.accent : colors.textSecondary} />
                        )}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.deviceName, isSelected && styles.deviceNameActive]} numberOfLines={1}>
                            {d.deviceName}
                          </Text>
                          {state?.song && (
                            <Text style={styles.deviceSubtitle} numberOfLines={1}>
                              {state.song.title} · {state.song.artist}
                            </Text>
                          )}
                        </View>
                      </Pressable>
                      {(isDevicePlaying || isSelected) && (
                        <View style={styles.badgeRow}>
                          {isDevicePlaying && (
                            <View style={[styles.badge, styles.badgePlaying]}>
                              <Text style={styles.badgePlayingText}>En cours de lecture</Text>
                            </View>
                          )}
                          {isSelected && (
                            <View style={[styles.badge, styles.badgeControlled]}>
                              <Text style={styles.badgeControlledText}>Contrôlé</Text>
                            </View>
                          )}
                        </View>
                      )}
                      {((!isDevicePlaying && anyPlaying) || (state?.song && !isDevicePlaying) || (hasLocalSong && !localPlaying)) && (
                        <View style={styles.handoffRow}>
                          {!isDevicePlaying && anyPlaying && (
                            <Pressable
                              style={({ pressed }) => [styles.handoffChip, styles.handoffChipPrimary, pressed && styles.pressed]}
                              onPress={handleSwitchRemote}
                              accessibilityRole="button"
                              accessibilityLabel={`Passer l'écoute vers ${d.deviceName}`}
                            >
                              <Cast size={13} color={colors.accent} />
                              <Text style={[styles.handoffChipText, { color: colors.accent }]}>Passer l'écoute ici</Text>
                            </Pressable>
                          )}
                          {state?.song && !isDevicePlaying && (
                            <Pressable
                              style={({ pressed }) => [styles.handoffChip, styles.handoffChipPrimary, pressed && styles.pressed]}
                              onPress={() => {
                                if (handoffToHere(d.deviceId)) showToast(`Lecture reprise depuis ${d.deviceName}`)
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={`Reprendre la lecture de ${d.deviceName} sur ce téléphone`}
                            >
                              <ArrowLeftRight size={13} color={colors.accent} />
                              <Text style={[styles.handoffChipText, { color: colors.accent }]}>Reprendre sur ce téléphone</Text>
                            </Pressable>
                          )}
                          {hasLocalSong && !localPlaying && (
                            <Pressable
                              style={({ pressed }) => [styles.handoffChip, pressed && styles.pressed]}
                              onPress={() => {
                                if (handoffToDevice(d.deviceId)) showToast(`Lecture transférée vers ${d.deviceName}`)
                              }}
                              accessibilityRole="button"
                              accessibilityLabel={`Transférer la lecture vers ${d.deviceName}`}
                            >
                              <Cast size={13} color={colors.textSecondary} />
                              <Text style={styles.handoffChipText}>Transférer vers {d.deviceName}</Text>
                            </Pressable>
                          )}
                        </View>
                      )}
                    </View>
                  )
                })}
              </View>
            )
          })()}

          {isRemote && selected && (
            <View style={styles.transportCard}>
              <View style={styles.transportInfo}>
                <Cast size={16} color={colors.accent} />
                <Text style={styles.transportTitle} numberOfLines={1}>
                  {selected.song ? `${selected.song.title} · ${selected.song.artist}` : 'Aucune lecture'}
                </Text>
              </View>
              <View style={styles.transportControls}>
                <Pressable onPress={() => sendCommand('prev')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Titre précédent">
                  <SkipBack size={22} color={colors.text} fill={colors.text} />
                </Pressable>
                <Pressable
                  style={styles.playButton}
                  onPress={() => sendCommand('toggle')}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={selected.isPlaying ? 'Pause' : 'Lecture'}
                >
                  {selected.isPlaying ? (
                    <Pause size={20} color="#000" fill="#000" />
                  ) : (
                    <Play size={20} color="#000" fill="#000" />
                  )}
                </Pressable>
                <Pressable onPress={() => sendCommand('next')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Titre suivant">
                  <SkipForward size={22} color={colors.text} fill={colors.text} />
                </Pressable>
              </View>
            </View>
          )}
        </>
      )}

      {!enabled && (
        <EmptyState
          icon={Cast}
          title="Contrôle à distance désactivé"
          hint="Activez-le pour piloter ce téléphone depuis le PC, ou l'inverse (même réseau Wi-Fi requis)."
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  resumeCard: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.accent
  },
  resumeHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  resumeHeaderText: { flex: 1, color: colors.accent, fontSize: 13, fontWeight: '700' },
  resumeTrack: { color: colors.text, fontSize: 15, fontWeight: '600' },
  resumeMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  serverButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  serverButton: { paddingVertical: spacing.sm, minHeight: 36 },
  removeButton: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border
  },
  removeButtonText: { color: colors.textSecondary, fontWeight: '600', fontSize: 13 },
  serverStatus: { color: colors.textSecondary, fontSize: 12, marginTop: spacing.sm },
  serverOk: { color: colors.accent },
  serverBad: { color: colors.textSecondary },
  pairHint: { color: colors.textMuted, fontSize: 12, lineHeight: 17, marginBottom: spacing.sm },
  codeInput: { fontFamily: 'monospace', letterSpacing: 2, marginBottom: spacing.sm },
  pairButton: { alignSelf: 'flex-start', marginTop: spacing.sm },
  unpair: { color: colors.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: spacing.md },
  container: { flex: 1, backgroundColor: colors.base },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, marginTop: 3 },
  card: { backgroundColor: colors.elevated, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, marginBottom: spacing.xs },
  input: {
    backgroundColor: colors.raised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: 14
  },
  manualRow: { flexDirection: 'row', gap: spacing.sm },
  manualInput: { flex: 1 },
  connectButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectButtonText: { color: '#000', fontWeight: '700', fontSize: 13 },
  pressed: { opacity: 0.6 },
  sectionSpacer: { marginTop: spacing.sm, marginBottom: spacing.md },
  sectionTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginBottom: spacing.sm },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm
  },
  deviceCard: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
    gap: spacing.sm
  },
  deviceRowInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md
  },
  handoffRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  handoffChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.hover,
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 6
  },
  handoffChipPrimary: {
    backgroundColor: tint(colors.accent, 0.14)
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  badge: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3
  },
  badgePlaying: {
    backgroundColor: tint(colors.accent, 0.16)
  },
  badgePlayingText: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700'
  },
  badgeControlled: {
    backgroundColor: colors.hover
  },
  badgeControlledText: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '600'
  },
  handoffChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700'
  },
  deviceRowActive: { borderWidth: 1, borderColor: colors.accent },
  deviceName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  deviceNameActive: { color: colors.accent },
  deviceSubtitle: { color: colors.textSecondary, fontSize: 12, marginTop: 2 },
  transportCard: {
    backgroundColor: colors.elevated,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
    gap: spacing.md
  },
  transportInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  transportTitle: { flex: 1, color: colors.text, fontSize: 13, fontWeight: '500' },
  transportControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xl },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center'
  }
})
