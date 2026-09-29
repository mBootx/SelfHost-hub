import { useState } from 'react'
import { FolderOpen } from 'lucide-react-native'
import { useFileBrowserStore } from '@/store/filebrowserStore'
import LoginLayout, { Field } from '@/components/LoginLayout'
import { colors } from '@/constants/theme'

export default function LoginScreen() {
  const connect = useFileBrowserStore((s) => s.connect)
  const [url, setUrl] = useState('http://')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(): Promise<void> {
    setError(null)
    setLoading(true)
    try {
      await connect(url, username, password, true)
    } catch (err: any) {
      setError(err?.message || 'Connexion impossible')
    } finally {
      setLoading(false)
    }
  }

  return (
    <LoginLayout
      icon={FolderOpen}
      accent={colors.filebrowser}
      title="Connexion à FileBrowser"
      subtitle="Interface OpenMediaVault"
      error={error}
      loading={loading}
      onSubmit={handleSubmit}
    >
      <Field
        label="URL du serveur"
        value={url}
        onChangeText={setUrl}
        placeholder="http://192.168.1.10:8080"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Field label="Nom d'utilisateur" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
      <Field
        label="Mot de passe"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        returnKeyType="go"
        onSubmitEditing={handleSubmit}
      />
    </LoginLayout>
  )
}
