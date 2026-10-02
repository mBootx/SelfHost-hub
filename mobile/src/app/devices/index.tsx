import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Switch, StyleSheet, Alert } from 'react-native'
import { useNavigation } from 'expo-router'
import { Laptop, Smartphone, Play, Pause, SkipBack, SkipForward, Cast } from 'lucide-react-native'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import { EmptyState } from '@/components/Screen'
import { colors, radius, spacing } from '@/constants/theme'

function statusLabel(status: string, error: string | null): string {
  if (status === 'connected') return 'Connecté au PC'
  if (status === 'connecting') return 'Recherche du PC sur le réseau...'
  if (status === 'error') return error || 'Connexion impossible'
  return 'Désactivé'
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
  const pairing = useRemoteStore((s) => s.pairing)
  const pair = useRemoteStore((s) => s.pair)
  const unpair = useRemoteStore((s) => s.unpair)
  const selectDevice = useRemoteStore((s) => s.selectDevice)
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  const [nameDraft, setNameDraft] = useState(deviceName)
  const [manualIp, setManualIp] = useState('')
  const [codeDraft, setCodeDraft] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    navigation.setOptions({ title: 'Contrôle à distance' })
  }, [])

  useEffect(() => setNameDraft(deviceName), [deviceName])

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

  async function handleManualConnect(): Promise<void> {
    if (!manualIp.trim()) return
    setConnecting(true)
    await connectManual(manualIp.trim())
    setConnecting(false)
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.row}>
        <View style={styles.rowInfo}>
          <Text style={styles.rowTitle}>Activer le contrôle à distance</Text>
          <Text style={styles.rowMeta}>{statusLabel(status, error)}</Text>
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

          {!pairing && (
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

          {pairing && status === 'error' && (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>PC introuvable automatiquement - adresse IP</Text>
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

          {pairing && (
            <Pressable onPress={confirmUnpair} hitSlop={8} accessibilityRole="button" accessibilityLabel="Dissocier ce téléphone du PC">
              <Text style={styles.unpair}>Appairé avec un PC · Dissocier</Text>
            </Pressable>
          )}

          {status === 'connected' && (
            <View style={styles.sectionSpacer}>
              <Text style={styles.sectionTitle}>Lire sur</Text>

              <Pressable
                style={[styles.deviceRow, selectedDeviceId === LOCAL_DEVICE_ID && styles.deviceRowActive]}
                onPress={() => selectDevice(LOCAL_DEVICE_ID)}
              >
                <Smartphone size={18} color={selectedDeviceId === LOCAL_DEVICE_ID ? colors.accent : colors.textSecondary} />
                <Text style={[styles.deviceName, selectedDeviceId === LOCAL_DEVICE_ID && styles.deviceNameActive]}>
                  Ce téléphone
                </Text>
              </Pressable>

              {otherDevices.map((d) => {
                const state = devices[d.deviceId]
                const isSelected = selectedDeviceId === d.deviceId
                return (
                  <Pressable
                    key={d.deviceId}
                    style={[styles.deviceRow, isSelected && styles.deviceRowActive]}
                    onPress={() => selectDevice(d.deviceId)}
                  >
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
                          {state.song.title} - {state.song.artist}
                        </Text>
                      )}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          )}

          {isRemote && selected && (
            <View style={styles.transportCard}>
              <View style={styles.transportInfo}>
                <Cast size={16} color={colors.accent} />
                <Text style={styles.transportTitle} numberOfLines={1}>
                  {selected.song ? `${selected.song.title} - ${selected.song.artist}` : 'Aucune lecture'}
                </Text>
              </View>
              <View style={styles.transportControls}>
                <Pressable onPress={() => sendCommand('prev')} hitSlop={10}>
                  <SkipBack size={22} color={colors.text} fill={colors.text} />
                </Pressable>
                <Pressable style={styles.playButton} onPress={() => sendCommand('toggle')} hitSlop={10}>
                  {selected.isPlaying ? (
                    <Pause size={20} color="#000" fill="#000" />
                  ) : (
                    <Play size={20} color="#000" fill="#000" />
                  )}
                </Pressable>
                <Pressable onPress={() => sendCommand('next')} hitSlop={10}>
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
          hint="Active-le pour piloter ce téléphone depuis le PC, ou l'inverse - même réseau Wi-Fi requis."
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
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
