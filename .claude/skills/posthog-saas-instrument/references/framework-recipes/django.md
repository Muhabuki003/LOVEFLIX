# Django — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/python
WebFetch https://posthog.com/docs/libraries/js
```

Server-rendered Django uses the Python SDK for server captures and the JS snippet for client captures.

## Install

```bash
pip install posthog
# or via the project's dep manager
poetry add posthog
uv add posthog
```

Add to `requirements.txt` if the project uses it.

## Env vars

Match the project's convention. Common patterns:

- `os.environ` directly
- `django-environ` (most common)
- `python-decouple`

In `settings.py`:

```python
POSTHOG_TOKEN = env('POSTHOG_TOKEN', default=None)
POSTHOG_HOST = env('POSTHOG_HOST', default='https://us.i.posthog.com')
```

## Server-side client

Create `<project>/posthog_client.py`:

```python
from django.conf import settings
from posthog import Posthog

class _PosthogStub:
    def capture(self, *args, **kwargs): pass
    def identify(self, *args, **kwargs): pass
    def shutdown(self): pass

if settings.POSTHOG_TOKEN:
    posthog_client = Posthog(
        project_api_key=settings.POSTHOG_TOKEN,
        host=settings.POSTHOG_HOST,
    )
else:
    posthog_client = _PosthogStub()
```

Usage in a view:

```python
from .posthog_client import posthog_client

def create_note(request):
    note = Note.objects.create(user=request.user, body=request.POST['body'])
    posthog_client.capture(
        distinct_id=str(request.user.id),
        event='note_created',
        properties={'word_count': len(note.body.split())},
    )
    return redirect('note_detail', note.id)
```

For DRF, use the same pattern in viewsets / serializers' `save()` overrides.

## Client snippet

Add to your base template (`templates/base.html`) in the `<head>`:

```html
{% if posthog_token %}
  <script>
    <!-- the snippet from references/framework-recipes/static-html.md -->
    posthog.init('{{ posthog_token }}', {
      api_host: '{{ posthog_host }}',
      defaults: '2026-01-30'    // verify against current docs
    })
  </script>
{% endif %}
```

And pass the values via a context processor in `settings.py`:

```python
TEMPLATES = [
  {
    # ...
    'OPTIONS': {
      'context_processors': [
        # ...
        '<project>.context_processors.posthog',
      ],
    },
  },
]
```

`<project>/context_processors.py`:

```python
from django.conf import settings

def posthog(request):
    return {
        'posthog_token': settings.POSTHOG_TOKEN,
        'posthog_host': settings.POSTHOG_HOST,
    }
```

## Reverse proxy

Same options as Rails:

- Configure at the web server layer (Nginx, Caddy)
- Use a Django middleware to proxy `/ingest/*`
- Or skip and accept the ad-blocker hit

## CSP

If using `django-csp`:

```python
CSP_SCRIPT_SRC = ("'self'", "https://*.posthog.com")
CSP_CONNECT_SRC = ("'self'", "https://*.posthog.com")
```

## Identify

In the auth completion view (custom signup, allauth's signup signal, Django's `user_logged_in` signal):

```python
from django.contrib.auth.signals import user_logged_in
from django.dispatch import receiver
from .posthog_client import posthog_client

@receiver(user_logged_in)
def identify_on_login(sender, request, user, **kwargs):
    posthog_client.capture(
        distinct_id=str(user.id),
        event='user_signed_in',
        properties={'method': 'email'},  # or detect from request
    )
    # The client-side identify will happen on the next page load via the snippet's auto-context.
```

For client-side identify on page render, include a small inline `<script>posthog.identify('{{ user.id }}', { email: '{{ user.email }}' })</script>` in `base.html` when `{% if user.is_authenticated %}`.

## Gotchas

- `distinct_id` must be a string. `str(user.id)`.
- In Celery tasks or management commands, call `posthog_client.shutdown()` at the end to flush before the process exits.
- Test runs: set `POSTHOG_TOKEN` to empty in test settings so the stub is used; otherwise tests fire real captures.
