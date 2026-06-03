# Ruby on Rails — PostHog Recipe

## Verify before applying

```
WebFetch https://posthog.com/docs/libraries/ruby
WebFetch https://posthog.com/docs/libraries/js
```

Rails apps are server-rendered HTML; the client side uses the JS snippet, the server side uses the Ruby SDK.

## Install (Ruby server SDK)

Add to `Gemfile`:

```ruby
gem 'posthog-ruby'
```

Then `bundle install`.

## Install (client-side snippet)

Add to `app/views/layouts/application.html.erb` in the `<head>`:

```erb
<% if Rails.application.credentials.dig(:posthog, :token).present? || ENV['POSTHOG_TOKEN'].present? %>
  <script>
    <!-- the snippet from references/framework-recipes/static-html.md, with token inlined as: -->
    posthog.init('<%= ENV.fetch('POSTHOG_TOKEN') { Rails.application.credentials.dig(:posthog, :token) } %>', {
      api_host: '<%= ENV.fetch('POSTHOG_HOST', 'https://us.i.posthog.com') %>',
      defaults: '2026-01-30'    // verify against current docs
    })
  </script>
<% end %>
```

Inline the full snippet from [static-html.md](static-html.md) where the comment indicates.

## Env vars

Rails has two conventions; pick the one already in use:

- **Encrypted credentials**: `bin/rails credentials:edit` and add:
  ```yaml
  posthog:
    token: phc_xxxxx
    host: https://us.i.posthog.com
  ```
- **ENV vars**: add `POSTHOG_TOKEN` and `POSTHOG_HOST` to `.env` (with `dotenv-rails`) or to the deployment environment directly.

The ERB snippet above checks both; prefer one over the other in the codebase.

## Server-side client (Ruby)

Create `config/initializers/posthog.rb`:

```ruby
require 'posthog-ruby'

POSTHOG = if (token = ENV['POSTHOG_TOKEN'] || Rails.application.credentials.dig(:posthog, :token))
  PostHog::Client.new(
    api_key: token,
    host: ENV.fetch('POSTHOG_HOST') { Rails.application.credentials.dig(:posthog, :host) } || 'https://us.i.posthog.com',
    on_error: Proc.new { |status, msg| Rails.logger.error("[posthog] #{status}: #{msg}") }
  )
else
  # Stub so call sites never crash in dev/staging without a token.
  Class.new {
    def capture(*); end
    def identify(*); end
    def shutdown; end
  }.new
end
```

Usage in a controller:

```ruby
class NotesController < ApplicationController
  def create
    @note = current_user.notes.create!(note_params)
    POSTHOG.capture(
      distinct_id: current_user.id.to_s,
      event: 'note_created',
      properties: { word_count: @note.body.split.size }
    )
    redirect_to @note
  end
end
```

In a Sidekiq job or webhook handler, the same pattern. Always `POSTHOG.shutdown` at the end of a short-lived script (rake task, runner). In a Rails app process, the SDK batches internally; let it.

## Reverse proxy

Rails apps usually have a load balancer or reverse proxy in front (Nginx, Cloudflare, the platform's edge). Configure the proxy at that layer:

- **Nginx**: location blocks for `/ingest/static/`, `/ingest/array/`, `/ingest/` → corresponding `*.posthog.com` upstreams.
- **Cloudflare**: a Worker or Page Rule.

If the Rails app is small and behind no reverse proxy, you can add `Rack::Proxy` middleware for the same effect.

## CSP

If the app uses the `content_security_policy` initializer:

```ruby
# config/initializers/content_security_policy.rb
Rails.application.config.content_security_policy do |policy|
  policy.script_src  :self, :https, 'https://*.posthog.com'
  policy.connect_src :self, :https, 'https://*.posthog.com'
end
```

## Identify

In the `SessionsController#create` action (or Devise's `after_sign_in_path_for`, or the OAuth callback), emit a `posthog.identify` from the rendered page via a small inline script. Or, capture from the server using `POSTHOG.identify(distinct_id: user.id.to_s, properties: {...})` to set traits even before the page renders.

For Devise:

```ruby
class ApplicationController < ActionController::Base
  def after_sign_in_path_for(resource)
    POSTHOG.capture(distinct_id: resource.id.to_s, event: 'user_signed_in')
    super
  end
end
```

## Gotchas

- Use `current_user.id.to_s` — PostHog `distinct_id` is a string.
- The Ruby SDK uses background threads for flushing. In short-lived processes (rake tasks, one-off scripts), call `POSTHOG.shutdown` explicitly.
