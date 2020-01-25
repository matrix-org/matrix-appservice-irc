**Breaking Change** - Static mappings can now set a channel key:
 - This changes the config schema, even if you do not make use of this feature. You MUST update your existing `mappings` to use the new `roomIds`:
   ```yaml
   old:
     mappings:
       "#thepub": ["!kieouiJuedJoxtVdaG:localhost"]

   new:
     mappings:
       "#thepub":
         roomIds: ["!kieouiJuedJoxtVdaG:localhost"]
   ```
 - The key is automatically used to join Matrix users to the mapped channel. They do not need to know the key. For example, you can bridge password-protected IRC channels to invite-only Matrix rooms:
   ```yaml
   mappings:
     "#viplounge":
       roomIds: ["!xKtieojhareASOokdc:localhost"]
       key: "vip-pass"
   ```
