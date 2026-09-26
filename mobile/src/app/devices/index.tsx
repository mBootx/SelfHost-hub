import { useEffect, useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, Switch, StyleSheet } from 'react-native'
import { useNavigation } from 'expo-router'
import { Laptop, Smartphone, Play, Pause, SkipBack, SkipForward, Cast } from 'lucide-react-native'
import { useRemoteStore, LOCAL_DEVICE_ID } from '@/store/remoteStore'
import { EmptyState } from '@/components/Screen'
import { colors, radius, spacing } from '@/constants/theme'

function statusLabel(status: string, error: string | null): string {
  if (status === 'connected') return 'Connecte au PC'
  if (status === 'connecting') return 'Recherche du PC sur le reseau...'
  if (status === 'error') return error || 'Connexion impossible'
  return 'Desactive'
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
  const selectDevice = useRemoteStore((s) => s.selectDevice)
  const sendCommand = useRemoteStore((s) => s.sendCommand)

  const [nameDraft, setNameDraft] = useState(deviceName)
  const [manualIp, setManualIp] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    navigation.setOptions({ title: 'Controle a distance' })
  }, [])

  useEffect(() => setNameDraft(deviceName), [deviceName])

  const otherDevices = deviceList.filter((d) => d.deviceId !== LOCAL_DEVICE_ID)
  const selected = selectedDeviceId !== LOCAL_DEVICE_ID ? devices[selectedDeviceId] : null
  const isRemote = selectedDeviceId !== LOCAL_DEVICE_ID

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
          <Text style={styles.rowTitle}>Activer le controle a distance</Text>
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
            <Text style={styles.fieldLabel}>Nom de ce telephone</Text>
            <TextInput
              style={styles.input}
              value={nameDraft}
              onChangeText={setNameDraft}
              onBlur={() => nameDraft.trim() && setDeviceName(nameDraft.trim())}
              autoCapitalize="words"
              accessibilityLabel="Nom de ce telephone"
            />
          </View>

          {status === 'error' && (
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

          {status === 'connected' && (
            <View style={styles.sectionSpacer}>
              <Text style={styles.sectionTitle}>Lire sur</Text>

              <Pressable
                style={[styles.deviceRow, selectedDeviceId === LOCAL_DEVICE_ID && styles.deviceRowActive]}
                onPress={() => selectDevice(LOCAL_DEVICE_ID)}
              >
                <Smartphone size={18} color={selectedDeviceId === LOCAL_DEVICE_ID ? colors.accent : colors.textSecondary} />
                <Text style={[styles.deviceName, selectedDeviceId === LOCAL_DEVICE_ID && styles.deviceNameActive]}>
                  Ce telephone
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
          title="Controle a distance desactive"
          hint="Active-le pour piloter ce telephone depuis le PC, ou l'inverse - meme reseau Wi-Fi requis."
        />
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
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
