import { useState } from 'react'
import { Music } from 'lucide-react-native'
import { useNavidromeStore } from '@/store/navidromeStore'
import LoginLayout, { Field } from '@/components/LoginLayout'
import { colors } from '@/constants/theme'

export default function LoginScreen() {
  const connect = useNavidromeStore((s) => s.connect)
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
      icon={Music}
      accent={colors.accent}
      iconColor="#000"
      title="Connexion à Navidrome"
      subtitle="Votre serveur de musique auto-hébergé"
      error={error}
      loading={loading}
      onSubmit={handleSubmit}
    >
      <Field
        label="URL du serveur"
        value={url}
        onChangeText={setUrl}
        placeholder="http://192.168.1.10:4533"
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
