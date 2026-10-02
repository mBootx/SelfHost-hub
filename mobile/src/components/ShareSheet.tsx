import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { FileText, Folder, X } from 'lucide-react-native'
import FolderPicker from '@/components/filebrowser/FolderPicker'
import { formatSize } from '@/services/photoLayout'
import { forgetShared, noteName, SharedFile, useShareStore, writeNote } from '@/services/shareIntake'
import { baseName } from '@/services/fileNames'
import { ConflictChoice, findConflicts, planUploads } from '@/services/uploadConflicts'
import { storage } from '@/services/storage'
import { useAppLockStore } from '@/store/appLockStore'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import { useToastStore } from '@/store/toastStore'
import { useUploadStore } from '@/store/uploadStore'
import { colors, radius, spacing } from '@/constants/theme'

const LAST_FOLDER_KEY = 'share.lastFolder'
/** How many shared file names the sheet lists before saying "and N more". */
const LISTED = 5

function plural(count: number, one: string, many: string): string {
  return `${count} ${count > 1 ? many : one}`
}

/**
 * "Partager" > "SelfHost Hub", from any app: asks where in FileBrowser the shared files go, then sends them
 * through the same upload queue as the Files tab. Text shared on its own (a link from the browser) is saved as
 * a note. Nothing is sent before the person confirms, and nothing is replaced unless they say so.
 */
export default function ShareSheet() {
  const pending = useShareStore((s) => s.pending)
  const dismiss = useShareStore((s) => s.dismiss)
  const unlocked = useAppLockStore((s) => s.status === 'unlocked')
  const client = useFileBrowserStore((s) => s.client)
  const connecting = useFileBrowserStore((s) => s.status === 'connecting')
  const startUpload = useUploadStore((s) => s.startUpload)
  const showToast = useToastStore((s) => s.show)

  const [folder, setFolder] = useState('/')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const [title, setTitle] = useState('')

  const open = pending !== null
  const isNote = pending !== null && pending.files.length === 0 && !!pending.text
  const text = pending?.text ?? ''

  // Where the last share went is where the next one is offered to go.
  useEffect(() => {
    if (!open) return
    let stale = false
    storage
      .loadPref<string>(LAST_FOLDER_KEY)
      .then((saved) => {
        if (!stale && typeof saved === 'string' && saved.startsWith('/')) setFolder(saved)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [open])

  useEffect(() => {
    if (isNote) setTitle(noteName(text, new Date()))
  }, [isNote, text])

  const names = useMemo(() => (pending ? pending.files.map((file) => file.name) : []), [pending])

  if (!open || !unlocked) return null

  function cancel(): void {
    if (sending) return
    if (pending) forgetShared(pending.files)
    dismiss()
  }

  /** The files whose names are already taken in the folder: the person decides, and may also back out. */
  function askChoice(taken: ReadonlySet<string>, wanted: string[]): Promise<ConflictChoice | null> {
    const conflicts = findConflicts(wanted, taken)
    if (conflicts.length === 0) return Promise.resolve('keep-both')
    const first = wanted[conflicts[0]]
    return new Promise((resolve) => {
      Alert.alert(
        conflicts.length === 1 ? 'Ce fichier existe déjà' : `${conflicts.length} fichiers existent déjà`,
        conflicts.length === 1
          ? `« ${first} » est déjà dans ce dossier. Que faire ? (Touchez en dehors pour annuler.)`
          : `« ${first} » et ${plural(conflicts.length - 1, 'autre', 'autres')} sont déjà dans ce dossier. Que faire ? (Touchez en dehors pour annuler.)`,
        [
          { text: 'Ignorer', onPress: () => resolve('skip') },
          { text: 'Garder les deux', onPress: () => resolve('keep-both') },
          { text: 'Remplacer', style: 'destructive', onPress: () => resolve('replace') }
        ],
        { cancelable: true, onDismiss: () => resolve(null) }
      )
    })
  }

  async function send(): Promise<void> {
    if (!client || !pending || sending) return
    setSending(true)
    try {
      const items: SharedFile[] = isNote ? [writeNote(title, text)] : pending.files
      let existing: string[] = []
      try {
        existing = (await client.list(folder)).map((entry) => entry.name)
      } catch {
        // A folder that can't be read is reported by the upload itself.
      }
      // Names already in the folder, plus those of uploads still on their way there.
      const { tasks } = useUploadStore.getState()
      const taken = new Set([...existing, ...tasks.filter((t) => t.destPath === folder && (t.status === 'queued' || t.status === 'uploading')).map((t) => t.filename)])
      const wanted = items.map((item) => item.name)
      const choice = await askChoice(taken, wanted)
      if (choice === null) {
        if (isNote) forgetShared(items)
        return
      }
      const plan = planUploads(wanted, taken, choice)
      storage.savePref(LAST_FOLDER_KEY, folder).catch(() => {})
      const started = plan.map((planned) =>
        startUpload({ uri: items[planned.index].uri, name: planned.name, size: items[planned.index].size }, folder, client, { override: planned.override })
      )
      const sentIndexes = new Set(plan.map((planned) => planned.index))
      forgetShared(items.filter((_, index) => !sentIndexes.has(index)))
      dismiss()
      if (plan.length > 0) showToast(`${plural(plan.length, 'fichier en cours d’envoi', 'fichiers en cours d’envoi')} vers ${folder === '/' ? 'la racine' : baseName(folder)}`)
      // The copies are only needed until the uploads are over, successful or not.
      void Promise.all(started).finally(() => forgetShared(items))
    } finally {
      setSending(false)
    }
  }

  const unreadable = pending?.unreadable ?? 0
  const nothing = !isNote && (pending?.files.length ?? 0) === 0
  const shownNames = names.slice(0, LISTED)
  const total = pending ? pending.files.reduce((sum, file) => sum + file.size, 0) : 0

  let body: React.ReactNode
  if (!client) {
    body = (
      <Text style={styles.message}>
        {connecting ? 'Connexion à FileBrowser en cours…' : "Connectez-vous d'abord à FileBrowser (onglet Fichiers) : c'est là que les fichiers sont envoyés."}
      </Text>
    )
  } else if (nothing) {
    body = (
      <Text style={styles.message}>
        {unreadable > 0 ? `Ce partage ne contenait ${plural(unreadable, 'fichier lisible', 'fichiers lisibles')} : l’application qui l’a envoyé a peut-être retiré son autorisation.` : 'Ce partage ne contient aucun fichier.'}
      </Text>
    )
  } else {
    body = (
      <>
        {isNote ? (
          <>
            <Text style={styles.sectionLabel}>Texte reçu, à enregistrer comme note</Text>
            <Text style={styles.preview} numberOfLines={4}>
              {text}
            </Text>
            <Text style={styles.sectionLabel}>Nom du fichier</Text>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Nom de la note"
            />
          </>
        ) : (
          <>
            <Text style={styles.sectionLabel}>
              {plural(pending!.files.length, 'fichier', 'fichiers')} · {formatSize(total)}
            </Text>
            <ScrollView style={styles.fileList} nestedScrollEnabled>
              {shownNames.map((name, index) => (
                <View key={`${name}-${index}`} style={styles.fileRow}>
                  <FileText size={16} color={colors.textMuted} />
                  <Text style={styles.fileName} numberOfLines={1}>
                    {name}
                  </Text>
                </View>
              ))}
              {names.length > LISTED ? <Text style={styles.more}>… et {names.length - LISTED} autres</Text> : null}
            </ScrollView>
            {unreadable > 0 ? <Text style={styles.warning}>{plural(unreadable, 'fichier n’a pas pu être lu', 'fichiers n’ont pas pu être lus')}.</Text> : null}
          </>
        )}
        <Text style={styles.sectionLabel}>Envoyer dans</Text>
        <Pressable style={styles.folderRow} onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Choisir le dossier de destination">
          <Folder size={18} color="#60a5fa" />
          <Text style={styles.folderName} numberOfLines={1}>
            {folder === '/' ? 'Racine' : folder}
          </Text>
          <Text style={styles.change}>Changer</Text>
        </Pressable>
      </>
    )
  }

  const canSend = !!client && !nothing && !sending && (!isNote || title.trim().length > 0)

  return (
    <Modal visible transparent animationType="slide" onRequestClose={cancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={styles.title}>Envoyer vers FileBrowser</Text>
            <Pressable onPress={cancel} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer">
              <X size={22} color={colors.text} />
            </Pressable>
          </View>
          {body}
          <View style={styles.actions}>
            <Pressable style={styles.secondary} onPress={cancel} accessibilityRole="button">
              <Text style={styles.secondaryText}>{client && !nothing ? 'Annuler' : 'Fermer'}</Text>
            </Pressable>
            {client && !nothing ? (
              <Pressable style={[styles.primary, !canSend && styles.primaryOff]} disabled={!canSend} onPress={() => void send()} accessibilityRole="button" accessibilityLabel="Envoyer">
                {sending ? <ActivityIndicator color="#000000" /> : <Text style={[styles.primaryText, !canSend && { color: colors.textMuted }]}>Envoyer</Text>}
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
      {picking && client ? (
        <FolderPicker
          client={client}
          startPath={folder}
          title="Dossier de destination"
          confirmLabel="Envoyer"
          onPick={(picked) => {
            setFolder(picked)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.elevated, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  title: { flex: 1, color: colors.text, fontSize: 17, fontWeight: '700', marginRight: spacing.md },
  message: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, paddingVertical: spacing.md },
  sectionLabel: { color: colors.textMuted, fontSize: 12, marginTop: spacing.sm },
  fileList: { maxHeight: 160 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 4 },
  fileName: { flex: 1, color: colors.text, fontSize: 14 },
  more: { color: colors.textMuted, fontSize: 12, paddingVertical: 4 },
  warning: { color: colors.warning, fontSize: 12 },
  preview: { color: colors.textSecondary, fontSize: 13, lineHeight: 18, backgroundColor: colors.raised, borderRadius: radius.sm, padding: spacing.md },
  input: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, color: colors.text, fontSize: 14 },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, backgroundColor: colors.raised, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  folderName: { flex: 1, color: colors.text, fontSize: 14 },
  change: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  secondary: { flex: 1, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border, paddingVertical: spacing.md, alignItems: 'center' },
  secondaryText: { color: colors.text, fontWeight: '700', fontSize: 14 },
  primary: { flex: 1, borderRadius: radius.full, backgroundColor: colors.accent, paddingVertical: spacing.md, alignItems: 'center' },
  primaryOff: { backgroundColor: colors.hover },
  primaryText: { color: '#000000', fontWeight: '800', fontSize: 14 }
})
